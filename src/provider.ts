import type { LlmProvider, ProviderMessage, StreamEvent, StreamOptions, TokenUsage } from "./types.js";
import { configuredSetting, type ThinkingLevel } from "./settings.js";

export interface AnthropicProviderOptions {
  name?: string;
  apiKey?: string;
  authToken?: string;
  model: string;
  baseUrl: string;
  thinkingLevel?: ThinkingLevel;
}

const CLAUDE_CODE_BETAS = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
].join(",");

interface AnthropicEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; stop_reason?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  readonly mode = "live" as const;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #authToken: string | undefined;
  readonly #baseUrl: string;
  readonly #thinkingLevel: ThinkingLevel;

  constructor(options: AnthropicProviderOptions) {
    this.name = options.name ?? "Anthropic";
    this.#apiKey = options.apiKey;
    this.#authToken = options.authToken;
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#thinkingLevel = options.thinkingLevel ?? "max";
  }

  async *stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${this.#baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CLAUDE_CODE_BETAS,
        "user-agent": "claude-cli/2.1.88 (undefined, sdk-cli)",
        "x-stainless-package-version": "0.74.0",
        ...(this.#apiKey ? { "x-api-key": this.#apiKey } : {}),
        ...(this.#authToken ? { authorization: `Bearer ${this.#authToken}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 32_000,
        stream: true,
        ...(options?.tools?.length ? { tools: options.tools } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.thinking === false ? {} : { thinking: { type: "adaptive" } }),
        ...(options?.thinking === false ? {} : { output_config: { effort: this.#thinkingLevel } }),
        system: options?.system
          ?? "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.",
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
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use"
            && event.index !== undefined && event.content_block.id && event.content_block.name) {
            yield {
              type: "tool_use_start",
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta"
            && event.index !== undefined) {
            const partialJson = (event.delta as { partial_json?: string }).partial_json;
            if (partialJson) yield { type: "tool_input_delta", index: event.index, partialJson };
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

export function createProvider(
  environment: NodeJS.ProcessEnv,
  settings: { auth_key?: string; auth_url?: string; default_model?: string } = {},
): LlmProvider {
  const hasEnvironmentCredentials = environment.ANTHROPIC_AUTH_TOKEN !== undefined
    || environment.ANTHROPIC_API_KEY !== undefined;
  const apiKey = configuredSetting(environment.ANTHROPIC_API_KEY);
  const authToken = configuredSetting(environment.ANTHROPIC_AUTH_TOKEN)
    ?? (!hasEnvironmentCredentials ? configuredSetting(settings.auth_key) : undefined);
  if (!authToken && !apiKey) {
    throw new Error("Set auth_key in ~/.amber/settings.toml, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY before starting AMBER");
  }
  const model = configuredSetting(environment.ANTHROPIC_MODEL ?? settings.default_model);
  if (!model) throw new Error("Set default_model in ~/.amber/settings.toml or ANTHROPIC_MODEL before starting AMBER");
  const baseUrl = configuredSetting(environment.ANTHROPIC_BASE_URL ?? settings.auth_url)
    ?? "https://api.anthropic.com";
  return new AnthropicProvider({
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
    model,
    baseUrl,
  });
}

function mapUsage(usage: AnthropicUsage): Partial<TokenUsage> {
  const hasInput = usage.input_tokens !== undefined
    || usage.cache_creation_input_tokens !== undefined
    || usage.cache_read_input_tokens !== undefined;
  return {
    ...(hasInput ? {
      input: (usage.input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0),
    } : {}),
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
