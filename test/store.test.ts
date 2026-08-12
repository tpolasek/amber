import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store.js";

test("creates, persists, and lists sessions newest first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();

  const first = await store.create();
  assert.match(first.id, /^[a-z]+\.[a-z]+\.[a-z]+$/);
  first.title = "First session";
  first.messages.push({
    id: "message-1",
    role: "user",
    content: "Hello, agent",
    createdAt: new Date().toISOString(),
    status: "complete",
  });
  await store.save(first);

  const loaded = await store.get(first.id);
  assert.equal(loaded?.title, "First session");
  assert.equal(loaded?.messages[0]?.content, "Hello, agent");

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: first.id,
    title: "First session",
    createdAt: first.createdAt,
    updatedAt: loaded?.updatedAt,
    messageCount: 1,
    preview: "Hello, agent",
  });
});

test("creates durable numbered revisions without changing the original", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const original = await store.create();
  original.messages.push({
    id: "message-1", role: "user", content: "Keep me", createdAt: new Date().toISOString(), status: "complete",
  });
  await store.save(original);

  const second = await store.createRevision(original);
  const third = await store.createRevision(second);
  assert.equal(second.id, `${original.id}.2`);
  assert.equal(third.id, `${original.id}.3`);
  assert.deepEqual(second.messages, []);
  assert.equal((await store.get(original.id))?.messages[0]?.content, "Keep me");
});

test("forks a session with independent history and a provenance banner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const original = await store.create();
  original.messages.push({
    id: "message-1", role: "user", content: "Keep me", createdAt: new Date().toISOString(), status: "complete",
  });
  await store.save(original);
  const banner = {
    id: "banner-1",
    role: "assistant" as const,
    content: `Forked from session: ${original.id}`,
    createdAt: new Date().toISOString(),
    status: "complete" as const,
    kind: "fork-banner" as const,
    sourceSessionId: original.id,
  };

  const fork = await store.createFork(original, banner);
  assert.notEqual(fork.id, original.id);
  assert.deepEqual(fork.messages, [original.messages[0], banner]);
  fork.messages[0]!.content = "Changed only in the fork";
  assert.equal(original.messages[0]?.content, "Keep me");
  assert.deepEqual((await store.get(fork.id))?.messages, [original.messages[0], banner]);
});

test("rejects invalid session identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  assert.equal(await store.get("../../secret"), null);
});
