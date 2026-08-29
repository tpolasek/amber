import type { ThinkingLevel } from "./types.js";
export type { ThinkingLevel } from "./types.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(`Thinking level must be one of: ${THINKING_LEVELS.join(", ")}`);
}

export function nextThinkingLevel(current: ThinkingLevel): ThinkingLevel {
  const index = THINKING_LEVELS.indexOf(current);
  return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
}
