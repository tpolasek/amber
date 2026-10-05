import type { LlmProvider, Message, ProviderMessage, Session, StreamOptions, TokenUsage, ToolCall } from "./types.js";

export interface ProviderRoundOptions {
  provider: LlmProvider;
  history: ProviderMessage[];
  streamOptions: StreamOptions;
  signal: AbortSignal;
  session: Session;
  assistantMessage: Message;
  emit: (event: string, data: unknown) => void;
  checkpoint: () => Promise<void>;
  onStopReason: (reason: string) => void;
}

export async function collectProviderRound(options: ProviderRoundOptions): Promise<{
  toolDrafts: Map<number, { call: ToolCall; inputJson: string }>;
  stopReason: string;
}> {
  const { provider, history, streamOptions, signal, session, assistantMessage, emit, checkpoint } = options;
  const toolDrafts = new Map<number, { call: ToolCall; inputJson: string }>();
  let usage: Partial<TokenUsage> = {};
  let stopReason = "";
  for await (const event of provider.stream(history, signal, streamOptions)) {
    if (event.type === "delta") {
      assistantMessage.content += event.text;
      emit("delta", { text: event.text });
      await checkpoint();
    } else if (event.type === "thinking_delta") {
      assistantMessage.thinkingProvider = provider.protocol;
      assistantMessage.thinking = (assistantMessage.thinking ?? "") + event.thinking;
      emit("thinking_delta", { thinking: event.thinking });
      await checkpoint();
    } else if (event.type === "thinking_signature_delta") {
      assistantMessage.thinkingProvider = provider.protocol;
      assistantMessage.thinkingSignature = (assistantMessage.thinkingSignature ?? "") + event.signature;
      await checkpoint();
    } else if (event.type === "tool_use_start") {
      const call: ToolCall = {
        id: event.id,
        name: event.name,
        input: {},
        status: "queued",
        output: "",
      };
      toolDrafts.set(event.index, { call, inputJson: "" });
      (assistantMessage.toolCalls ??= []).push(call);
      emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
    } else if (event.type === "tool_input_delta") {
      const draft = toolDrafts.get(event.index);
      if (draft) draft.inputJson += event.partialJson;
    } else if (event.type === "usage") {
      usage = { ...usage, ...event.usage };
    } else if (event.type === "done" && event.stopReason !== undefined) {
      stopReason = event.stopReason;
      options.onStopReason(stopReason);
    }
  }

  assistantMessage.status = "complete";
  if (usage.input !== undefined && usage.output !== undefined) {
    assistantMessage.usage = usage as TokenUsage;
    session.contextTokens = usage.total ?? usage.input + usage.output;
  }
  for (const draft of toolDrafts.values()) {
    try {
      const parsed = JSON.parse(draft.inputJson || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool input must be an object");
      draft.call.input = parsed as Record<string, unknown>;
    } catch (error) {
      draft.call.status = "error";
      draft.call.output = `Invalid tool input: ${error instanceof Error ? error.message : "Unknown provider error"}`;
    }
  }
  return { toolDrafts, stopReason };
}
