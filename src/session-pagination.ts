import type { Message, Session } from "./types.js";

// Rendered messages per page.
export const SESSION_PAGE_SIZE = 50;

// tool-result, skill, and agent-notification attach to the message before them.
export function isRenderedMessage(message: Message): boolean {
  return message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification";
}

export interface MessagePage {
  messages: Message[];
  /** True when older messages exist before the returned page. */
  hasMore: boolean;
}

export function pageSessionMessages(messages: Message[], beforeId?: string | null): MessagePage {
  const end = beforeId === undefined || beforeId === null
    ? messages.length
    : messages.findIndex((message) => message.id === beforeId);
  if (end <= 0) return { messages: [], hasMore: false };

  let rendered = 0;
  let start = end;
  while (start > 0) {
    const candidate = messages[start - 1]!;
    if (isRenderedMessage(candidate)) {
      if (rendered >= SESSION_PAGE_SIZE) break;
      rendered += 1;
    }
    start -= 1;
  }
  // Leading attachments belong to a section older than the page.
  while (start < end && !isRenderedMessage(messages[start]!)) start += 1;
  const hasMore = messages.slice(0, start).some(isRenderedMessage);
  return { messages: messages.slice(start, end), hasMore };
}

export interface SessionPage {
  session: Session;
  hasMore: boolean;
}

export function paginateSession(session: Session, beforeId?: string | null): SessionPage {
  const page = pageSessionMessages(session.messages, beforeId);
  return { session: { ...session, messages: page.messages }, hasMore: page.hasMore };
}
