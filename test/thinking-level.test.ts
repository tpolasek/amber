import test from "node:test";
import assert from "node:assert/strict";
import { nextThinkingLevel, parseThinkingLevel, THINKING_LEVELS } from "../src/thinking-level.js";

test("cycles through every thinking level and wraps", () => {
  assert.deepEqual(THINKING_LEVELS, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(THINKING_LEVELS.map(nextThinkingLevel), ["low", "medium", "high", "xhigh", "max", "none"]);
});

test("validates persisted thinking levels", () => {
  for (const level of THINKING_LEVELS) assert.equal(parseThinkingLevel(level), level);
  assert.throws(() => parseThinkingLevel("extreme"), /Thinking level must be one of/);
  assert.throws(() => parseThinkingLevel(1), /Thinking level must be one of/);
});
