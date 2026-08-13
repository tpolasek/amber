import { createHash } from "node:crypto";

export const TOOL_LOOP_REPETITIONS = 3;
export const TOOL_LOOP_WINDOW_MS = 30_000;
const MAX_TRACKED_CYCLE_LENGTH = 4;

export interface TrackedToolCall {
  name: string;
  input: Record<string, unknown>;
  status: string;
  output: string;
}

export interface ToolLoopDetection {
  repetitions: number;
  cycleLength: number;
  toolNames: string[];
}

interface TrackedRound {
  fingerprint: string;
  toolNames: string[];
  completedAt: number;
}

export class ToolLoopTracker {
  readonly #rounds: TrackedRound[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(calls: TrackedToolCall[]): ToolLoopDetection | null {
    if (calls.length === 0) return null;
    const completedAt = this.#now();
    this.#rounds.push({
      fingerprint: fingerprint(calls),
      toolNames: calls.map((call) => call.name),
      completedAt,
    });
    const maximumRounds = TOOL_LOOP_REPETITIONS * MAX_TRACKED_CYCLE_LENGTH;
    if (this.#rounds.length > maximumRounds) this.#rounds.splice(0, this.#rounds.length - maximumRounds);

    for (let cycleLength = 1; cycleLength <= MAX_TRACKED_CYCLE_LENGTH; cycleLength += 1) {
      const roundsInPattern = cycleLength * TOOL_LOOP_REPETITIONS;
      if (this.#rounds.length < roundsInPattern) continue;
      const pattern = this.#rounds.slice(-cycleLength);
      const candidate = this.#rounds.slice(-roundsInPattern);
      if (completedAt - candidate[0]!.completedAt > TOOL_LOOP_WINDOW_MS) continue;
      const repeats = candidate.every((round, index) =>
        round.fingerprint === pattern[index % cycleLength]!.fingerprint);
      if (!repeats) continue;
      return {
        repetitions: TOOL_LOOP_REPETITIONS,
        cycleLength,
        toolNames: [...new Set(pattern.flatMap((round) => round.toolNames))],
      };
    }
    return null;
  }
}

export function formatToolLoopError(detection: ToolLoopDetection): string {
  const tools = detection.toolNames.join(", ") || "unknown tool";
  const cycle = detection.cycleLength === 1 ? "the same tool call" : `a ${detection.cycleLength}-round tool cycle`;
  return `Agent stopped after repeating ${cycle} ${detection.repetitions} times without progress (${tools})`;
}

function fingerprint(calls: TrackedToolCall[]): string {
  const hash = createHash("sha256");
  for (const call of calls) {
    hash.update(call.name);
    hash.update("\0");
    hash.update(stableStringify(call.input));
    hash.update("\0");
    hash.update(call.status);
    hash.update("\0");
    hash.update(call.output);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
