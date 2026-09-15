import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCacheUsage,
  aggregateSessionTokenUsage,
  cacheHitRatio,
  formatCacheHitPercentage,
  markCacheUsageReset,
} from "../src/cache-usage.js";
import type { Message, Session } from "../src/types.js";

const now = new Date().toISOString();

function response(id: string, input: number, cached?: number): Message {
  return {
    id,
    role: "assistant",
    content: id,
    createdAt: now,
    status: "complete",
    usage: { input, output: 1, ...(cached !== undefined ? { cached } : {}) },
  };
}

test("aggregates cached tokens over total request input", () => {
  const usage = aggregateCacheUsage([
    response("first", 105, 100),
    response("second", 205, 180),
  ]);
  assert.deepEqual(usage, { input: 310, cached: 280, requests: 2 });
  assert.equal(cacheHitRatio(usage!), 280 / 310);
});

test("aggregates lifetime session input, output, cache reads, and cache misses", () => {
  const unsupported = response("unsupported", 20);
  unsupported.usage!.output = 3;
  unsupported.status = "error";
  assert.deepEqual(aggregateSessionTokenUsage([
    response("first", 105, 100),
    response("second", 205, 180),
    unsupported,
  ]), {
    input: 330,
    output: 5,
    cacheRead: 280,
    cacheMiss: 50,
  });
});

test("session cache usage keeps hit plus miss equal to input", () => {
  assert.deepEqual(aggregateSessionTokenUsage([response("invalid-cache-count", 10, 12)]), {
    input: 10,
    output: 1,
    cacheRead: 10,
    cacheMiss: 0,
  });
});

test("formats a request with new input below a 100% cache hit rate", () => {
  const usage = aggregateCacheUsage([response("request", 105, 100)]);
  assert.equal(formatCacheHitPercentage(cacheHitRatio(usage!)), "95.2%");
  assert.equal(formatCacheHitPercentage(cacheHitRatio({ input: 1_001, cached: 1_000 })), "99.9%");
});

test("compaction resets the aggregate", () => {
  const messages: Message[] = [
    response("before", 105, 100),
    {
      id: "compact",
      role: "assistant",
      content: "Context compacted here",
      createdAt: now,
      status: "complete",
      kind: "compact-banner",
    },
    response("after", 25, 10),
  ];
  assert.deepEqual(aggregateCacheUsage(messages), { input: 25, cached: 10, requests: 1 });
  assert.equal(aggregateCacheUsage(messages.slice(0, 2)), undefined);
});

test("usage without cache telemetry does not make an unknown rate look like a miss", () => {
  assert.equal(aggregateCacheUsage([response("unsupported", 105)]), undefined);
});

test("forking starts a new cache aggregate", () => {
  const forkBanner: Message = {
    id: "fork",
    role: "assistant",
    content: "Forked from session: source",
    createdAt: now,
    status: "complete",
    kind: "fork-banner",
    sourceSessionId: "source",
  };
  const messages = [response("source-response", 105, 100), forkBanner, response("fork-response", 25, 10)];
  assert.deepEqual(aggregateCacheUsage(messages), { input: 25, cached: 10, requests: 1 });
  assert.equal(aggregateCacheUsage(messages.slice(0, 2)), undefined);
});

test("an explicit boundary resets cache usage when the model changes", () => {
  const before = response("before", 105, 100);
  const after = response("after", 25, 10);
  assert.deepEqual(aggregateCacheUsage([before, after], before.id), { input: 25, cached: 10, requests: 1 });

  const session: Session = {
    id: "session",
    title: "session",
    createdAt: now,
    updatedAt: now,
    messages: [before],
  };
  markCacheUsageReset(session);
  assert.equal(session.cacheUsageResetThroughMessageId, before.id);
});
