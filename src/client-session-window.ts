import type { Message, Session } from "./client-types.js";

export const sessionWindow: { hasMore: boolean; loading: boolean } = {
  hasMore: false,
  loading: false,
};

export function resetSessionWindow(hasMore: boolean): void {
  sessionWindow.hasMore = hasMore;
  sessionWindow.loading = false;
}

// tool-result, skill, and agent-notification attach to the message before them.
export function isRenderedMessage(message: Message): boolean {
  return message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification";
}

export interface MergedSessionPage {
  session: Session;
  /** True when previously loaded messages were kept in front of the page. */
  mergedWithLoaded: boolean;
}

// Keeps older loaded messages in front when the new page overlaps them.
export function mergeSessionPage(loaded: Session | null, page: Session): MergedSessionPage {
  if (!loaded || loaded.id !== page.id || page.messages.length === 0) {
    return { session: page, mergedWithLoaded: false };
  }
  const firstPageMessageId = page.messages[0]?.id;
  if (!firstPageMessageId) return { session: page, mergedWithLoaded: false };
  const overlap = loaded.messages.findIndex((message) => message.id === firstPageMessageId);
  if (overlap === -1) return { session: page, mergedWithLoaded: false };
  return {
    session: { ...page, messages: [...loaded.messages.slice(0, overlap), ...page.messages] },
    mergedWithLoaded: true,
  };
}

// Merged windows keep their own hasMore; replaced windows adopt the page's.
export function applySessionPage(loaded: Session | null, page: Session, hasMore: boolean): MergedSessionPage {
  const merged = mergeSessionPage(loaded, page);
  if (!merged.mergedWithLoaded) sessionWindow.hasMore = hasMore;
  return merged;
}
