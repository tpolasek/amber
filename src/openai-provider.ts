import type {
  LlmProvider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderSystemBlock,
  StreamEvent,
  StreamOptions,
  ThinkingLevel,
  TokenUsage,
  ToolDefinition,
} from "./types.js";
import { providerApiUrl, type DiscoveredModel, type ProviderDriver } from "./provider-driver.js";
import { readServerSentEvents } from "./sse.js";

const REASONING_STATE_PREFIX = "openai-reasoning:";

interface OpenAIProviderOptions {
  name?: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  thinkingLevel?: ThinkingLevel;
}

interface OpenAIEvent {
  type?: string;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item?: OpenAIOutputItem;
  response?: {
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: OpenAIUsage | null;
  };
  error?: { message?: string };
}

interface OpenAIOutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string;
  summary?: unknown[];
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export class OpenAIProvider implements LlmProvider {
  readonly name: string;
  readonly protocol = "openai" as const;
  readonly mode = "live" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #thinkingLevel: ThinkingLevel;

  constructor(options: OpenAIProviderOptions) {
    this.name = options.name ?? "OpenAI";
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = options.baseUrl;
    this.#thinkingLevel = options.thinkingLevel ?? "xhigh";
  }

  async *stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent> {
    const reasoningEnabled = options?.thinking !== false && this.#thinkingLevel !== "none";
    const response = await fetch(providerApiUrl(this.#baseUrl, "responses"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: toOpenAIInput(messages),
        instructions: systemText(options?.system),
        max_output_tokens: 32_000,
        stream: true,
        store: false,
        parallel_tool_calls: true,
        ...(options?.tools?.length ? { tools: options.tools.map(toOpenAITool) } : {}),
        ...(reasoningEnabled ? {
          reasoning: { effort: openAIEffort(this.#thinkingLevel), summary: "auto" },
          include: ["reasoning.encrypted_content"],
        } : {}),
        ...(!reasoningEnabled && options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${extractApiError(body)}`);
    }

    const toolArguments = new Map<number, string>();
    let completed = false;
    for await (const frame of readServerSentEvents(response)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const event = JSON.parse(frame.data) as OpenAIEvent;
      if (event.type === "error") throw new Error(event.error?.message ?? "OpenAI stream error");
      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message ?? "OpenAI response failed");
      }
      if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta") && event.delta) {
        yield { type: "delta", text: event.delta };
      }
      if ((event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta")
        && event.delta) {
        yield { type: "thinking_delta", thinking: event.delta };
      }
      if (event.type === "response.output_item.added" && event.item?.type === "function_call"
        && event.output_index !== undefined && event.item.name) {
        const callId = event.item.call_id ?? event.item.id;
        if (callId) {
          toolArguments.set(event.output_index, "");
          yield { type: "tool_use_start", index: event.output_index, id: callId, name: event.item.name };
        }
      }
      if (event.type === "response.function_call_arguments.delta"
        && event.output_index !== undefined && event.delta) {
        toolArguments.set(event.output_index, (toolArguments.get(event.output_index) ?? "") + event.delta);
        yield { type: "tool_input_delta", index: event.output_index, partialJson: event.delta };
      }
      if (event.type === "response.function_call_arguments.done"
        && event.output_index !== undefined && event.arguments) {
        const accumulated = toolArguments.get(event.output_index) ?? "";
        const missing = event.arguments.startsWith(accumulated) ? event.arguments.slice(accumulated.length) : "";
        if (missing) {
          toolArguments.set(event.output_index, event.arguments);
          yield { type: "tool_input_delta", index: event.output_index, partialJson: missing };
        }
      }
      if (event.type === "response.output_item.done" && event.item?.type === "reasoning"
        && event.item.encrypted_content) {
        yield { type: "thinking_signature_delta", signature: serializeReasoningItem(event.item) };
      }
      if (event.type === "response.completed") {
        completed = true;
        if (event.response?.usage) yield { type: "usage", usage: mapUsage(event.response.usage) };
        yield { type: "done", stopReason: "completed" };
      }
      if (event.type === "response.incomplete") {
        completed = true;
        if (event.response?.usage) yield { type: "usage", usage: mapUsage(event.response.usage) };
        yield { type: "done", stopReason: event.response?.incomplete_details?.reason ?? "incomplete" };
      }
    }
    if (!completed) throw new Error("OpenAI response stream ended before completion");
  }
}

export const openAIDriver: ProviderDriver = {
  protocol: "openai",
  defaultThinkingLevel: "xhigh",
  async discoverModels(connection, fetcher): Promise<DiscoveredModel[]> {
    const response = await fetcher(providerApiUrl(connection.baseUrl, "models"), {
      headers: { authorization: `Bearer ${connection.authKey}` },
    });
    if (!response.ok) throw new Error(`model list failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .filter((candidate): candidate is { id: string } =>
        typeof candidate.id === "string" && Boolean(candidate.id) && !candidate.id.includes("/")
      )
      .map((candidate) => ({ id: candidate.id, displayName: candidate.id }));
    return [...new Map(models.map((model) => [model.id, model])).values()];
  },
  createProvider(connection) {
    return new OpenAIProvider({
      name: connection.name,
      apiKey: connection.authKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
      thinkingLevel: connection.thinkingLevel,
    });
  },
};

function toOpenAIInput(messages: ProviderMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (block.provider === "openai") input.push(...parseReasoningItems(block.signature));
      } else if (block.type === "text") {
        input.push({ role: message.role, content: block.text });
      } else if (block.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResultText(block),
        });
      }
    }
  }
  return input;
}

function toolResultText(block: Extract<ProviderContentBlock, { type: "tool_result" }>): string {
  const content = typeof block.content === "string"
    ? block.content
    : block.content.map((part) => part.text).join("\n");
  return block.is_error ? `Error: ${content}` : content;
}

function toOpenAITool(tool: ToolDefinition): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

function openAIEffort(level: Exclude<ThinkingLevel, "none">): "low" | "medium" | "high" | "xhigh" {
  return level === "max" ? "xhigh" : level;
}

function systemText(system: string | ProviderSystemBlock[] | undefined): string {
  if (typeof system === "string") return system;
  if (system) return system.map((block) => block.text).join("\n\n");
  return "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.";
}

function serializeReasoningItem(item: OpenAIOutputItem): string {
  return `${REASONING_STATE_PREFIX}${JSON.stringify({
    type: "reasoning",
    ...(item.id ? { id: item.id } : {}),
    encrypted_content: item.encrypted_content,
    summary: item.summary ?? [],
  })}\n`;
}

function parseReasoningItems(signature: string): unknown[] {
  const items: unknown[] = [];
  for (const line of signature.split("\n")) {
    if (!line.startsWith(REASONING_STATE_PREFIX)) continue;
    try {
      const item = JSON.parse(line.slice(REASONING_STATE_PREFIX.length)) as unknown;
      if (item && typeof item === "object" && !Array.isArray(item)) items.push(item);
    } catch {
      // Ignore corrupt opaque state while retaining the visible conversation.
    }
  }
  return items;
}

function mapUsage(usage: OpenAIUsage): Partial<TokenUsage> {
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
