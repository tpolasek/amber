import type { Message, ProviderMessage, SessionCompaction } from "./types.js";

const SUMMARY_PREFIX = "The following is a generated summary of the earlier conversation. Use it as user-provided context when continuing the session.\n\n";

export function isModelMessage(message: Message): boolean {
  return message.kind === undefined || message.kind === "chat";
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
  const history = activeMessages
    .filter((message) => message.id !== excludedMessageId && message.status === "complete" && isModelMessage(message))
    .map(({ role, content }) => ({ role, content }));

  if (compaction && boundaryIndex >= 0) {
    history.unshift({ role: "user", content: `${SUMMARY_PREFIX}${compaction.summary}` });
  }
  return history;
}
