import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderSystemBlock,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from "./types.js";
import { providerApiUrl } from "./provider-driver.js";
import { imageDataUrl } from "./message-images.js";
import { readServerSentEvents } from "./sse.js";

export interface ChatCompletionsOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ProviderMessage[];
  system?: string | ProviderSystemBlock[] | null;
  tools?: ToolDefinition[];
  temperature?: number;
  signal: AbortSignal;
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage | null;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// Chat Completions has no reasoning control: reasoning models decide server-side
// and stream their reasoning back as `reasoning_content` (or `reasoning`) deltas.
// `thinking_level` therefore affects nothing on the wire for this path.
export async function* streamChatCompletions(options: ChatCompletionsOptions): AsyncGenerator<StreamEvent> {
  const response = await fetch(providerApiUrl(options.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        ...(options.system === null ? [] : [{ role: "system" as const, content: systemText(options.system) }]),
        ...toChatMessages(options.messages),
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 32_000,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools?.length
        ? { tools: options.tools.map(toChatTool), tool_choice: "auto" as const }
        : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Chat completions request failed (${response.status}): ${extractApiError(body)}`);
  }

  const startedToolCalls = new Set<number>();
  let completed = false;
  for await (const frame of readServerSentEvents(response)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    const chunk = JSON.parse(frame.data) as ChatChunk;
    if (chunk.usage) yield { type: "usage", usage: mapUsage(chunk.usage) };
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (reasoning) yield { type: "thinking_delta", thinking: reasoning };
    if (choice.delta?.content) yield { type: "delta", text: choice.delta.content };
    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const name = call.function?.name;
      if (name && !startedToolCalls.has(index)) {
        startedToolCalls.add(index);
        yield { type: "tool_use_start", index, id: call.id ?? `call_${index}`, name };
      }
      const argumentsDelta = call.function?.arguments;
      if (argumentsDelta) yield { type: "tool_input_delta", index, partialJson: argumentsDelta };
    }
    if (choice.finish_reason) {
      completed = true;
      yield { type: "done", stopReason: choice.finish_reason };
    }
  }
  if (!completed) throw new Error("Chat completions stream ended before completion");
}

function toChatMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    const text: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];
    for (const block of message.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (block.type === "image") {
        images.push({ type: "image_url", image_url: { url: imageDataUrl({ mediaType: block.source.media_type, data: block.source.data }) } });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
      }
      // Thinking blocks have no Chat Completions replay format and are dropped.
    }
    result.push(...toolResults);
    if (message.role === "assistant") {
      if (text.length > 0 || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: text.join("\n"),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (images.length > 0) {
      result.push({
        role: "user",
        content: [
          ...(text.length > 0 ? [{ type: "text", text: text.join("\n") }] : []),
          ...images,
        ],
      });
    } else if (text.length > 0) {
      result.push({ role: "user", content: text.join("\n") });
    }
  }
  return result;
}

function toChatTool(tool: ToolDefinition): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function toolResultText(block: Extract<ProviderContentBlock, { type: "tool_result" }>): string {
  const content = typeof block.content === "string"
    ? block.content
    : block.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  return block.is_error ? `Error: ${content}` : content;
}

function systemText(system: string | ProviderSystemBlock[] | undefined): string {
  if (typeof system === "string") return system;
  if (system) return system.map((block) => block.text).join("\n\n");
  return "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.";
}

function mapUsage(usage: ChatUsage): Partial<TokenUsage> {
  return {
    ...(usage.prompt_tokens !== undefined ? { input: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { output: usage.completion_tokens } : {}),
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
