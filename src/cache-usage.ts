import type { CacheUsage, Message, Session, SessionTokenUsage } from "./types.js";

export function aggregateSessionTokenUsage(messages: Message[]): SessionTokenUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheMiss = 0;
  for (const message of messages) {
    const usage = message.usage;
    if (!usage) continue;
    const requestCacheRead = Math.max(0, Math.min(usage.input, usage.cached ?? 0));
    input += usage.input;
    output += usage.output;
    cacheRead += requestCacheRead;
    cacheMiss += usage.input - requestCacheRead;
  }
  return { input, output, cacheRead, cacheMiss };
}

export function aggregateCacheUsage(messages: Message[], resetThroughMessageId?: string): CacheUsage | undefined {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const resetsCache = message?.id === resetThroughMessageId
      || (message?.status === "complete" && (message.kind === "compact-banner"
        || (message.kind === "fork-banner" && message.sourceSessionId !== undefined)));
    if (resetsCache) {
      boundary = index;
      break;
    }
  }
  let input = 0;
  let cached = 0;
  let requests = 0;
  for (let index = boundary + 1; index < messages.length; index += 1) {
    const usage = messages[index]?.usage;
    if (usage?.cached === undefined) continue;
    input += usage.input;
    cached += usage.cached;
    requests += 1;
  }
  return requests > 0 ? { input, cached, requests } : undefined;
}

export function markCacheUsageReset(session: Session): void {
  const throughMessageId = session.messages.at(-1)?.id;
  if (throughMessageId) session.cacheUsageResetThroughMessageId = throughMessageId;
  else delete session.cacheUsageResetThroughMessageId;
}

export function cacheHitRatio(usage: Pick<CacheUsage, "input" | "cached">): number {
  if (usage.input <= 0) return 0;
  return Math.max(0, Math.min(1, usage.cached / usage.input));
}

export function formatCacheHitPercentage(ratio: number): string {
  const percentage = ratio >= 1 ? 100 : Math.floor(ratio * 1_000) / 10;
  return `${percentage}%`;
}
