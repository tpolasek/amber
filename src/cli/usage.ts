import type { CacheUsage, Message, Session, TokenUsage } from "../types.js";
import { cacheHitRatio, formatCacheHitPercentage } from "../cache-usage.js";
import { formatTokenCountInThousands } from "../client-formatters.js";

/** Active context: the compaction estimate when set, else the newest request's tokens. */
export function contextTokens(session: Session, latest?: Message): number {
  if (session.contextTokens !== undefined) return session.contextTokens;
  const usage = latest?.usage ?? newestUsage(session.messages);
  return usage ? usage.total ?? usage.input + usage.output : 0;
}

/** The footer's three meters: context, recent-9 and session cache hit rates. */
export function meterLine(session: Session, latest?: Message): string {
  return `CNTX ${formatTokenCountInThousands(contextTokens(session, latest))}k toks`
    + ` · CSH9 ${percentage(session.recentCacheUsage)}`
    + ` · CACH ${percentage(session.cacheUsage)}`;
}

export function usageLines(session: Session): string[] {
  const lines = [meterLine(session)];
  const cache = session.cacheUsage;
  if (cache) {
    lines.push(`cache ${cache.cached.toLocaleString()} of ${cache.input.toLocaleString()} input tokens`
      + ` over ${cache.requests.toLocaleString()} request${cache.requests === 1 ? "" : "s"}`);
  }
  const latest = newestUsage(session.messages);
  if (latest) lines.push(`latest ${tokens(latest.input)}→${tokens(latest.output)} tok`);
  return lines;
}

function newestUsage(messages: Message[]): TokenUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage;
    if (usage) return usage;
  }
  return undefined;
}

function percentage(usage: CacheUsage | undefined): string {
  return usage ? formatCacheHitPercentage(cacheHitRatio(usage)) : "--";
}

function tokens(count: number): string {
  return formatTokenCountInThousands(count);
}
