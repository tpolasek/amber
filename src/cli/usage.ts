import type { CacheUsage, Message, Session, TokenUsage } from "../types.js";
import { cacheHitRatio, formatCacheHitPercentage } from "../cache-usage.js";
import { formatTokenCountInThousands } from "../client-formatters.js";
import type { Run } from "./render.js";
import type { Theme } from "./theme.js";

/** Active context: the compaction estimate when set, else the newest request's tokens. */
export function contextTokens(session: Session, latest?: Message): number {
  if (session.contextTokens !== undefined) return session.contextTokens;
  const usage = latest?.usage ?? newestUsage(session.messages);
  return usage ? usage.total ?? usage.input + usage.output : 0;
}

/** A `LABEL value` meter: accented label, softly colored value. */
function meter(label: string, value: string, theme: Theme, fill = ""): Run[] {
  return [
    { text: label, codes: withFill(theme.accent, fill) },
    { text: ` ${value}`, codes: withFill(theme.meterValue, fill) },
  ];
}

function separator(theme: Theme, fill = ""): Run {
  return { text: " · ", codes: withFill(theme.meterValue, fill) };
}

function withFill(codes: string, fill: string): string {
  return fill === "" ? codes : `${codes};${fill}`;
}

/** The footer's three meters: context, recent-9 and session cache hit rates.
 *  `fill` adds a background code under every run for the run footer. */
export function meterRuns(session: Session, theme: Theme, latest?: Message, fill = ""): Run[] {
  return [
    ...meter("CNTX", `${formatTokenCountInThousands(contextTokens(session, latest))}k toks`, theme, fill),
    separator(theme, fill),
    ...meter("CSH9", percentage(session.recentCacheUsage), theme, fill),
    separator(theme, fill),
    ...meter("CACH", percentage(session.cacheUsage), theme, fill),
  ];
}

export function usageRuns(session: Session, theme: Theme): Run[][] {
  const lines: Run[][] = [meterRuns(session, theme)];
  const cache = session.cacheUsage;
  if (cache) {
    lines.push(meter(
      "cache",
      `${cache.cached.toLocaleString()} of ${cache.input.toLocaleString()} input tokens`
        + ` over ${cache.requests.toLocaleString()} request${cache.requests === 1 ? "" : "s"}`,
      theme,
    ));
  }
  const latest = newestUsage(session.messages);
  if (latest) lines.push(meter("latest", `${tokens(latest.input)}→${tokens(latest.output)} tok`, theme));
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
