import type {
  LlmProvider,
  ProviderContentBlock,
  ProviderMessage,
  StreamEvent,
  StreamOptions,
  ThinkingLevel,
  TokenUsage,
} from "./types.js";
import { providerApiUrl, type DiscoveredModel, type ProviderDriver } from "./provider-driver.js";
import { readServerSentEvents } from "./sse.js";

export interface AnthropicProviderOptions {
  name?: string;
  authToken: string;
  model: string;
  baseUrl: string;
  thinkingLevel?: ThinkingLevel;
}

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
  readonly protocol = "anthropic" as const;
  readonly mode = "live" as const;
  readonly model: string;
  readonly #authToken: string;
  readonly #baseUrl: string;
  readonly #thinkingLevel: ThinkingLevel;

  constructor(options: AnthropicProviderOptions) {
    this.name = options.name ?? "Anthropic";
    this.#authToken = options.authToken;
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#thinkingLevel = options.thinkingLevel ?? "max";
  }

  async *stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent> {
    const thinkingLevel = options?.thinkingLevel ?? this.#thinkingLevel;
    const response = await fetch(`${providerApiUrl(this.#baseUrl, "messages")}?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stainless-package-version": "0.74.0",
        authorization: `Bearer ${this.#authToken}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 32_000,
        stream: true,
        ...(options?.tools?.length ? { tools: options.tools } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.thinking === false || thinkingLevel === "none" ? {} : { thinking: { type: "adaptive" } }),
        ...(options?.thinking === false || thinkingLevel === "none"
          ? {}
          : { output_config: { effort: anthropicEffort(thinkingLevel) } }),
        system: options?.system
          ?? "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.",
        messages: anthropicMessages(messages),
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${extractApiError(body)}`);
    }
    for await (const frame of readServerSentEvents(response)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const event = JSON.parse(frame.data) as AnthropicEvent;
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
}

export const anthropicDriver: ProviderDriver = {
  protocol: "anthropic",
  defaultThinkingLevel: "max",
  async discoverModels(connection, fetcher): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    let afterId: string | undefined;
    for (;;) {
      const url = new URL(providerApiUrl(connection.baseUrl, "models"));
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
      const response = await fetcher(url, {
        headers: {
          authorization: `Bearer ${connection.authKey}`,
        },
      });
      if (!response.ok) throw new Error(`model list failed (${response.status}): ${await response.text()}`);
      const body = await response.json() as {
        data?: Array<{ id?: unknown; display_name?: unknown }>;
        has_more?: unknown;
        last_id?: unknown;
      };
      for (const candidate of body.data ?? []) {
        if (typeof candidate.id !== "string" || !candidate.id || candidate.id.includes("/")) continue;
        models.push({
          id: candidate.id,
          displayName: typeof candidate.display_name === "string" && candidate.display_name
            ? candidate.display_name
            : candidate.id,
        });
      }
      if (body.has_more !== true || typeof body.last_id !== "string" || !body.last_id) break;
      afterId = body.last_id;
    }
    return uniqueModels(models);
  },
  createProvider(connection) {
    return new AnthropicProvider({
      name: connection.name,
      authToken: connection.authKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
      thinkingLevel: connection.thinkingLevel,
    });
  },
};

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

function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function anthropicEffort(level: Exclude<ThinkingLevel, "none">): "low" | "medium" | "high" | "max" {
  return level === "xhigh" ? "max" : level;
}

function anthropicMessages(messages: ProviderMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push(message);
      continue;
    }
    const content: ProviderContentBlock[] = [];
    for (const block of message.content) {
      if (block.type !== "thinking") content.push(block);
      else if (block.provider !== "openai") {
        content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      }
    }
    if (content.length > 0) result.push({ ...message, content });
  }
  return result;
}
