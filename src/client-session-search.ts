import type { Message } from "./client-types.js";
import { isRenderedMessage } from "./client-session-window.js";

export interface SessionTextMatch { messageId: string; field: "content" | "thinking" }

export function findSessionText(messages: Message[], query: string): SessionTextMatch | null {
  const needle = query.toLocaleLowerCase();
  if (!needle) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!isRenderedMessage(message)) continue;
    if (message.content.toLocaleLowerCase().includes(needle)) return { messageId: message.id, field: "content" };
    if (message.thinking?.toLocaleLowerCase().includes(needle)) return { messageId: message.id, field: "thinking" };
  }
  return null;
}
