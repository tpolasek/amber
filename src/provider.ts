import type { LlmProvider, ProviderMessage, StreamEvent, TokenUsage } from "./types.js";

interface AnthropicProviderOptions {
  apiKey?: string;
  authToken?: string;
  model: string;
  baseUrl: string;
  thinkingBudgetTokens?: number;
}

interface AnthropicEvent {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "Anthropic";
  readonly mode = "live" as const;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #authToken: string | undefined;
  readonly #baseUrl: string;
  readonly #thinkingBudgetTokens: number | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#authToken = options.authToken;
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#thinkingBudgetTokens = options.thinkingBudgetTokens;
  }

  async *stream(messages: ProviderMessage[], signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(this.#apiKey ? { "x-api-key": this.#apiKey } : {}),
        ...(this.#authToken ? { authorization: `Bearer ${this.#authToken}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: Math.max(4096, (this.#thinkingBudgetTokens ?? 0) + 8192),
        stream: true,
        ...(this.#thinkingBudgetTokens
          ? { thinking: { type: "enabled", budget_tokens: this.#thinkingBudgetTokens } }
          : {}),
        system: "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.",
        messages,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${extractApiError(body)}`);
    }
    if (!response.body) throw new Error("Anthropic returned an empty response stream");

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data) as AnthropicEvent;
          if (event.type === "error") throw new Error(event.error?.message ?? "Anthropic stream error");
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "delta", text: event.delta.text };
          }
          if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
            yield { type: "thinking_delta", thinking: event.delta.thinking };
          }
          if (event.type === "content_block_delta" && event.delta?.type === "signature_delta" && event.delta.signature) {
            yield { type: "thinking_signature_delta", signature: event.delta.signature };
          }
          if (event.type === "message_start" && event.message?.usage) {
            yield { type: "usage", usage: mapUsage(event.message.usage) };
          }
          if (event.type === "message_delta") {
            if (event.usage) yield { type: "usage", usage: mapUsage(event.usage) };
            yield { type: "done", ...(event.delta?.stop_reason ? { stopReason: event.delta.stop_reason } : {}) };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function createProvider(environment: NodeJS.ProcessEnv): LlmProvider {
  if (!environment.ANTHROPIC_AUTH_TOKEN && !environment.ANTHROPIC_API_KEY) {
    throw new Error("Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY before starting AMBER");
  }
  const baseUrl = environment.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const thinkingBudgetTokens = parseThinkingBudget(environment.ANTHROPIC_THINKING_BUDGET_TOKENS, baseUrl);
  return new AnthropicProvider({
    ...(environment.ANTHROPIC_API_KEY ? { apiKey: environment.ANTHROPIC_API_KEY } : {}),
    ...(environment.ANTHROPIC_AUTH_TOKEN ? { authToken: environment.ANTHROPIC_AUTH_TOKEN } : {}),
    model: environment.ANTHROPIC_MODEL
      ?? environment.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? (baseUrl.includes("api.z.ai") ? "glm-4.7" : "claude-sonnet-4-20250514"),
    baseUrl,
    ...(thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
  });
}

function parseThinkingBudget(value: string | undefined, baseUrl: string): number | undefined {
  if (value === undefined) return baseUrl.includes("api.z.ai") ? 32_768 : undefined;
  const budget = Number(value);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error("ANTHROPIC_THINKING_BUDGET_TOKENS must be a non-negative integer");
  }
  if (budget > 0 && budget < 1024) {
    throw new Error("ANTHROPIC_THINKING_BUDGET_TOKENS must be 0 or at least 1024");
  }
  return budget || undefined;
}

function mapUsage(usage: { input_tokens?: number; output_tokens?: number }): Partial<TokenUsage> {
  return {
    ...(usage.input_tokens !== undefined ? { input: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { output: usage.output_tokens } : {}),
  };
}

function extractApiError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || "Unknown error";
  }
}
