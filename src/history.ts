import type { Message, ProviderMessage } from "./types.js";

export function isModelMessage(message: Message): boolean {
  return message.kind === undefined || message.kind === "chat";
}

export function buildProviderHistory(messages: Message[], excludedMessageId?: string): ProviderMessage[] {
  return messages
    .filter((message) => message.id !== excludedMessageId && message.status === "complete" && isModelMessage(message))
    .map(({ role, content }) => ({ role, content }));
}
