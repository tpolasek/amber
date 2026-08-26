import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateHistoryTokens,
  formatCompactionBanner,
  formatCompactionSummary,
  generateCompactionSummary,
  shouldAutoCompact,
} from "../src/compaction.js";
import { BASE_COMPACT_PROMPT } from "../src/prompts.js";
import type { LlmProvider, ProviderMessage, StreamEvent } from "../src/types.js";

test("generates a trimmed summary without mutating the supplied history", async () => {
  const history: ProviderMessage[] = [{ role: "user", content: "Please add compact support" }];
  let received: ProviderMessage[] = [];
  const progress: number[] = [];
  const provider: LlmProvider = {
    name: "Test",
    protocol: "anthropic",
    model: "test-model",
    mode: "live",
    async *stream(messages: ProviderMessage[]): AsyncGenerator<StreamEvent> {
      received = messages;
      yield { type: "delta", text: "  Goal: add `/compact`." };
      yield { type: "delta", text: "\nStatus: pending.  " };
    },
  };

  const summary = await generateCompactionSummary(provider, history, new AbortController().signal, (characters) => {
    progress.push(characters);
  });
  assert.equal(summary, "Goal: add `/compact`.\nStatus: pending.");
  assert.deepEqual(history, [{ role: "user", content: "Please add compact support" }]);
  assert.deepEqual(received, [...history, { role: "user", content: BASE_COMPACT_PROMPT }]);
  assert.deepEqual(progress, [23, 42]);
});

test("strips the drafting analysis and formats the summary block", () => {
  assert.equal(
    formatCompactionSummary("<analysis>Private drafting notes</analysis>\n\n<summary>\n1. Primary Request:\n   Add compact support.\n</summary>"),
    "Summary:\n1. Primary Request:\n   Add compact support.",
  );
});

test("rejects an empty compaction response", async () => {
  const provider: LlmProvider = {
    name: "Test",
    protocol: "anthropic",
    model: "test-model",
    mode: "live",
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", text: "   " };
    },
  };

  await assert.rejects(
    generateCompactionSummary(provider, [], new AbortController().signal),
    /empty compaction summary/,
  );
});

test("estimates context tokens and formats the reduction banner", () => {
  assert.equal(estimateHistoryTokens([{ role: "user", content: "12345678" }]), 6);
  assert.equal(
    formatCompactionBanner(2_000, 500, 42),
    "Context compacted here · Estimated context: ≈2,000 → ≈500 tokens · Reduction: ≈1,500 tokens (75%) · 42 earlier messages remain visible",
  );
  assert.match(formatCompactionBanner(100, 125, 2), /Increase: ≈25 tokens \(25%\)/);
});

test("triggers automatic compaction at a model's configured threshold", () => {
  const history = [{ role: "user" as const, content: "x".repeat(400) }];
  assert.equal(shouldAutoCompact(undefined, 1_000_000, history), false);
  assert.equal(shouldAutoCompact(200, 199, []), false);
  assert.equal(shouldAutoCompact(200, 200, []), true);
  assert.equal(shouldAutoCompact(100, 0, history), true);
});
