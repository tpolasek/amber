import test from "node:test";
import assert from "node:assert/strict";
import { CompletionCache, completionsFor, type CompletionSources } from "../src/cli/complete.js";

const sources: CompletionSources = {
  models: [
    { key: "openai/gpt-5.3", model: "gpt-5.3" },
    { key: "openai/gpt-5.3-mini", model: "gpt-5.3-mini" },
    { key: "mock/mock-model", model: "mock-model" },
  ],
  sessions: ["abc12345", "def67890"],
  skills: ["commit", "usage", "reload"],
};

test("commands complete from the local list, built-ins, and skills", () => {
  assert.deepEqual(completionsFor("/mo", sources), ["/mode", "/model"]);
  // /usage is both a built-in and a skill: one hit.
  assert.deepEqual(completionsFor("/usa", sources), ["/usage"]);
  // /com names both the commit skill and the /compact built-in.
  assert.deepEqual(completionsFor("/com", sources), ["/commit", "/compact"]);
  assert.deepEqual(completionsFor("/sw", sources), ["/switch"]);
});

test("a bare slash lists every command once", () => {
  const hits = completionsFor("/", sources);
  assert.equal(new Set(hits).size, hits.length);
  for (const expected of ["/model", "/usage", "/commit", "/compact", "/quit"]) {
    assert.ok(hits.includes(expected), `missing ${expected}`);
  }
});

test("models complete by key or bare model id", () => {
  assert.deepEqual(completionsFor("/model gp", sources), [
    "/model openai/gpt-5.3",
    "/model openai/gpt-5.3-mini",
  ]);
  assert.deepEqual(completionsFor("/model openai/gpt-5.3-", sources), ["/model openai/gpt-5.3-mini"]);
  assert.deepEqual(completionsFor("/model mock", sources), ["/model mock/mock-model"]);
  assert.deepEqual(completionsFor("/model nope", sources), []);
});

test("effort levels, modes, and session prefixes complete", () => {
  assert.deepEqual(completionsFor("/effort hi", sources), ["/effort high"]);
  assert.deepEqual(completionsFor("/effort ", sources), [
    "/effort high",
    "/effort low",
    "/effort max",
    "/effort medium",
    "/effort none",
    "/effort xhigh",
  ]);
  assert.deepEqual(completionsFor("/mode ", sources), ["/mode chat", "/mode normal", "/mode plan"]);
  assert.deepEqual(completionsFor("/mode p", sources), ["/mode plan"]);
  assert.deepEqual(completionsFor("/mode nope", sources), []);
  assert.deepEqual(completionsFor("/switch abc", sources), ["/switch abc12345"]);
});

test("free-form arguments and plain text complete nothing", () => {
  assert.deepEqual(completionsFor("/new my session", sources), []);
  assert.deepEqual(completionsFor("/history 5", sources), []);
  assert.deepEqual(completionsFor("/model openai/gpt-5.3 extra", sources), []);
  assert.deepEqual(completionsFor("hello", sources), []);
  assert.deepEqual(completionsFor("", sources), []);
});

function cacheHarness() {
  let now = 1_000;
  const calls = { sessions: 0, models: 0, skills: [] as string[] };
  const cache = new CompletionCache({
    listSessions: async () => {
      calls.sessions += 1;
      return [{ id: "abc1234567" }, { id: "def7654321" }];
    },
    modelCatalog: async () => {
      calls.models += 1;
      return { models: [{ key: "mock/mock-model", model: "mock-model" }] };
    },
    skills: async (sessionId) => {
      calls.skills.push(sessionId);
      return ["commit"];
    },
  }, () => "s1", () => now);
  return {
    cache,
    calls,
    advance: (ms: number) => { now += ms; },
  };
}

test("the cache loads sources once and refreshes them after the TTL", async () => {
  const { cache, calls, advance } = cacheHarness();
  assert.deepEqual(await cache.completions("/mod"), ["/mode", "/model"]);
  assert.deepEqual(calls.skills, ["s1"]);
  await cache.completions("/com");
  assert.equal(calls.sessions, 1);
  assert.equal(calls.models, 1);
  assert.deepEqual(calls.skills, ["s1"]);

  advance(5_000);
  await cache.completions("/com");
  assert.equal(calls.sessions, 2);
  assert.deepEqual(calls.skills, ["s1", "s1"]);
  assert.equal(calls.models, 1); // models refresh on a longer window

  advance(60_000);
  await cache.completions("/model mock");
  assert.equal(calls.models, 2);
  assert.deepEqual(await cache.completions("/model mock"), ["/model mock/mock-model"]);
});

test("invalidating skills refetches them for the new session", async () => {
  const { cache, calls } = cacheHarness();
  await cache.completions("/");
  cache.invalidateSkills();
  await cache.completions("/");
  assert.deepEqual(calls.skills, ["s1", "s1"]);
});

test("a failing source keeps the previous list and retries next time", async () => {
  let now = 1_000;
  let fail = true;
  const cache = new CompletionCache({
    listSessions: async () => [{ id: "abc1234567" }],
    modelCatalog: async () => ({ models: [] }),
    skills: async () => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      return ["zzz"];
    },
  }, () => "s1", () => now);
  assert.deepEqual(await cache.completions("/zzz"), []);
  now += 1;
  assert.deepEqual(await cache.completions("/zzz"), ["/zzz"]);
});
