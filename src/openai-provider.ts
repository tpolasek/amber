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
import { streamChatCompletions } from "./openai-chat-provider.js";
import { readServerSentEvents } from "./sse.js";

const REASONING_STATE_PREFIX = "openai-reasoning:";

// BaseUrls whose servers lack /v1/responses (e.g. older LM Studio); they get the
// Chat Completions fallback for the lifetime of the process.
const chatOnlyBaseUrls = new Set<string>();

export interface ResolvedOpenAIAuth {
  accessToken: string;
  accountId?: string;
}

export type OpenAIAuthResolver = (signal?: AbortSignal) => Promise<ResolvedOpenAIAuth>;

interface OpenAIProviderOptions {
  name?: string;
  apiKey?: string;
  authResolver?: OpenAIAuthResolver;
  codex?: boolean;
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
  readonly #apiKey: string | undefined;
  readonly #authResolver: OpenAIAuthResolver | undefined;
  readonly #baseUrl: string;
  readonly #codex: boolean;
  readonly #thinkingLevel: ThinkingLevel;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey && !options.authResolver) throw new Error("OpenAI authentication is required");
    this.name = options.name ?? "OpenAI";
    this.#apiKey = options.apiKey;
    this.#authResolver = options.authResolver;
    this.model = options.model;
    this.#baseUrl = options.baseUrl;
    this.#codex = options.codex ?? false;
    this.#thinkingLevel = options.thinkingLevel ?? "xhigh";
  }

  async *stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent> {
    const chatFallback = (): AsyncGenerator<StreamEvent> => streamChatCompletions({
      apiKey: this.#apiKey ?? "",
      baseUrl: this.#baseUrl,
      model: this.model,
      messages,
      ...(options?.system !== undefined ? { system: options.system } : {}),
      ...(options?.tools !== undefined ? { tools: options.tools } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      signal,
    });
    if (!this.#codex && chatOnlyBaseUrls.has(this.#baseUrl)) {
      yield* chatFallback();
      return;
    }
    const thinkingLevel = options?.thinkingLevel ?? this.#thinkingLevel;
    const reasoningEnabled = options?.thinking !== false && thinkingLevel !== "none";
    const auth = this.#authResolver
      ? await this.#authResolver(signal)
      : { accessToken: this.#apiKey! };
    const headers: Record<string, string> = this.#codex
      ? {
          ...codexHeaders(auth),
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          accept: "text/event-stream",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${auth.accessToken}`,
        };
    const response = await fetch(
      this.#codex ? codexApiUrl(this.#baseUrl, "responses") : providerApiUrl(this.#baseUrl, "responses"),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          input: toOpenAIInput(messages),
          instructions: systemText(options?.system),
          ...(!this.#codex ? { max_output_tokens: 32_000 } : { text: { verbosity: "low" }, tool_choice: "auto" }),
          stream: true,
          store: false,
          parallel_tool_calls: true,
          ...(options?.tools?.length ? { tools: options.tools.map(toOpenAITool) } : {}),
          ...(reasoningEnabled ? {
            reasoning: { effort: openAIEffort(thinkingLevel), summary: "auto" },
            include: ["reasoning.encrypted_content"],
          } : {}),
          ...(!reasoningEnabled && options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        }),
        signal,
      },
    );

    if (!response.ok) {
      // A missing Responses endpoint (404) means the server only implements
      // Chat Completions; any other failure is a real request error.
      if (!this.#codex && response.status === 404) {
        chatOnlyBaseUrls.add(this.#baseUrl);
        yield* chatFallback();
        return;
      }
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

export function createOpenAICodexDriver(authResolver: OpenAIAuthResolver): ProviderDriver {
  return {
    protocol: "openai",
    defaultThinkingLevel: "xhigh",
    async discoverModels(connection, fetcher): Promise<DiscoveredModel[]> {
      const auth = await authResolver();
      if (!auth.accountId) throw new Error("OpenAI Codex authentication is missing the ChatGPT account id");
      const url = new URL(codexApiUrl(connection.baseUrl, "models"));
      // The backend gates models by minimal_client_version against this value,
      // so it must track a current Codex CLI release rather than Amber's own version.
      url.searchParams.set("client_version", codexClientVersion());
      const response = await fetcher(url, {
        headers: codexHeaders(auth),
      });
      if (!response.ok) throw new Error(`Codex model list failed (${response.status}): ${await response.text()}`);
      const body = await response.json() as {
        models?: Array<{
          slug?: unknown;
          display_name?: unknown;
          visibility?: unknown;
        }>;
      };
      return (body.models ?? [])
        // ChatGPT-subscription mode sees every model (supported_in_api is not a
        // filter); the picker gates on visibility "list" — "hide" and "none" stay out.
        .filter((candidate): candidate is { slug: string; display_name?: string } =>
          typeof candidate.slug === "string" && Boolean(candidate.slug)
          && candidate.visibility !== "hide" && candidate.visibility !== "none")
        .map((candidate) => ({
          id: candidate.slug,
          displayName: typeof candidate.display_name === "string" && candidate.display_name
            ? candidate.display_name
            : candidate.slug,
        }));
    },
    createProvider(connection) {
      return new OpenAIProvider({
        name: connection.name,
        authResolver,
        codex: true,
        baseUrl: connection.baseUrl,
        model: connection.model,
        thinkingLevel: connection.thinkingLevel,
      });
    },
  };
}

function codexApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const codexBase = base.endsWith("/codex") ? base : `${base}/codex`;
  return `${codexBase}/${path.replace(/^\/+/, "")}`;
}

// Codex CLI release the models request identifies as. Overridable for testing
// or when the backend requires a newer minimal_client_version.
const CODEX_CLIENT_VERSION = "0.150.1";

function codexClientVersion(): string {
  return process.env.AMBER_CODEX_CLIENT_VERSION ?? CODEX_CLIENT_VERSION;
}

function codexHeaders(auth: ResolvedOpenAIAuth): Record<string, string> {
  if (!auth.accountId) throw new Error("OpenAI Codex authentication is missing the ChatGPT account id");
  return {
    authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    originator: "amber",
  };
}

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
