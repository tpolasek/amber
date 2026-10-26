import test from "node:test";
import assert from "node:assert/strict";
import { contextTokens, meterLine, usageLines } from "../src/cli/usage.js";
import type { Session } from "../src/types.js";

function session(overrides: Partial<Session> = {}): Session {
  return { id: "s1", title: "", createdAt: "", updatedAt: "", messages: [], ...overrides };
}

test("context tokens prefer the compaction estimate over the newest request", () => {
  const messages = [{ id: "a1", role: "assistant" as const, content: "", createdAt: "", status: "complete" as const, usage: { input: 3_000, output: 500 } }];
  assert.equal(contextTokens(session({ messages })), 3_500);
  assert.equal(contextTokens(session({ messages, contextTokens: 1_200 })), 1_200);
  assert.equal(contextTokens(session()), 0);
});

test("meterLine formats context in thousands and cache hits as percentages", () => {
  const withUsage = session({
    contextTokens: 42_300,
    recentCacheUsage: { input: 1_000, cached: 870, requests: 9 },
    cacheUsage: { input: 10_000, cached: 7_100, requests: 20 },
  });
  assert.equal(meterLine(withUsage), "CNTX 42.3k toks · CSH9 87% · CACH 71%");
  assert.equal(meterLine(session()), "CNTX 0k toks · CSH9 -- · CACH --");
});

test("usageLines report the cache totals and the latest request", () => {
  const lines = usageLines(session({
    messages: [{ id: "a1", role: "assistant" as const, content: "", createdAt: "", status: "complete" as const, usage: { input: 12_300, output: 800 } }],
    cacheUsage: { input: 10_000, cached: 9_100, requests: 4 },
  }));
  assert.deepEqual(lines, [
    "CNTX 13.1k toks · CSH9 -- · CACH 91%",
    "cache 9,100 of 10,000 input tokens over 4 requests",
    "latest 12.3→0.8 tok",
  ]);
});
