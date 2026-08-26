import type { Message, ProviderMessage, SessionCompaction } from "./types.js";

const SUMMARY_PREFIX = "The following is a generated summary of the earlier conversation. Use it as user-provided context when continuing the session.\n\n";

export function isModelMessage(message: Message): boolean {
  return message.kind === undefined || message.kind === "chat";
}

function isProviderMessage(message: Message): boolean {
  return isModelMessage(message) || message.kind === "tool-result";
}

export function buildProviderHistory(
  messages: Message[],
  excludedMessageId?: string,
  compaction?: SessionCompaction,
): ProviderMessage[] {
  const boundaryIndex = compaction
    ? messages.findIndex((message) => message.id === compaction.throughMessageId)
    : -1;
  const activeMessages = boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
  const history: ProviderMessage[] = [];
  for (const message of activeMessages
    .filter((candidate) => candidate.id !== excludedMessageId && candidate.status === "complete" && isProviderMessage(candidate))) {
    const providerMessage: ProviderMessage = {
      role: message.role,
      content: message.kind === "tool-result" && message.toolUseId
        ? [{
            type: "tool_result",
            tool_use_id: message.toolUseId,
            content: message.contentBlocks ?? message.content,
            ...(message.contentBlocks && !message.toolError ? {} : { is_error: message.toolError === true }),
          }]
        : message.role === "assistant" && (message.thinking || message.toolCalls?.length)
          ? [
              ...(message.thinking && message.thinkingSignature
                ? [{
                    type: "thinking" as const,
                    thinking: message.thinking,
                    signature: message.thinkingSignature,
                    ...(message.thinkingProvider ? { provider: message.thinkingProvider } : {}),
                  }]
                : []),
              ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
              ...(message.toolCalls ?? []).map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ]
          : message.content,
    };
    const previous = history.at(-1);
    if (message.kind === "tool-result" && previous?.role === "user"
      && Array.isArray(previous.content) && Array.isArray(providerMessage.content)) {
      previous.content.push(...providerMessage.content);
    } else {
      history.push(providerMessage);
    }
  }

  if (compaction && boundaryIndex >= 0) {
    history.unshift({ role: "user", content: `${SUMMARY_PREFIX}${compaction.summary}` });
  }
  markTrailingCacheControl(history);
  return history;
}

function markTrailingCacheControl(history: ProviderMessage[]): void {
  const last = history.at(-1);
  if (last?.role !== "user" || !Array.isArray(last.content)) return;
  const block = last.content.at(-1);
  if (block && (block.type === "text" || block.type === "tool_result")) {
    block.cache_control = { type: "ephemeral" };
  }
}
