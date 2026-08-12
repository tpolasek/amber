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

test("rejects invalid session identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  assert.equal(await store.get("../../secret"), null);
});
