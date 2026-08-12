import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store.js";
import { BASIC_ENGLISH_2000 } from "../src/basic-english-2000.js";

test("creates, persists, and lists sessions newest first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();

  const first = await store.create();
  assert.match(first.id, /^[a-z]+\.[a-z]+\.[a-z]+$/);
  const sourceWords = new Set(BASIC_ENGLISH_2000.map((word) => word.toLowerCase().replace(/[^a-z]/g, "")));
  assert.ok(first.id.split(".").every((word) => sourceWords.has(word)));
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

test("clears a session in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  session.messages.push({
    id: "message-1", role: "user", content: "Keep me", createdAt: new Date().toISOString(), status: "complete",
  });
  session.compaction = {
    summary: "Keep me",
    throughMessageId: "message-1",
    createdAt: new Date().toISOString(),
    coveredMessageCount: 1,
  };
  session.fileReadState = {
    "/tmp/file.txt": { mtimeMs: 1, size: 4, hash: "hash", full: true },
  };
  await store.save(session);

  const cleared = await store.clear(session);
  assert.equal(cleared.id, session.id);
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.compaction, undefined);
  assert.equal(cleared.fileReadState, undefined);
  assert.deepEqual((await store.get(session.id))?.messages, []);
});

test("renames and deletes a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();

  const renamed = await store.rename(session, "Launch checklist");
  assert.equal(renamed.title, "Launch checklist");
  assert.equal((await store.get(session.id))?.title, "Launch checklist");
  assert.equal(await store.remove(session.id), true);
  assert.equal(await store.get(session.id), null);
  assert.equal(await store.remove(session.id), false);
  assert.equal(await store.remove("../../secret"), false);
});

test("forks a session with independent history and a provenance banner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const original = await store.create();
  original.messages.push({
    id: "message-1", role: "user", content: "Keep me", createdAt: new Date().toISOString(), status: "complete",
  });
  original.compaction = {
    summary: "The user asked to be kept.",
    throughMessageId: "message-1",
    createdAt: new Date().toISOString(),
    coveredMessageCount: 1,
  };
  original.directories = ["/tmp/example-workspace"];
  original.cwd = "/tmp/example-workspace/subdirectory";
  original.addDirInitialized = true;
  original.fileReadState = {
    "/tmp/example-workspace/file.txt": { mtimeMs: 1, size: 4, hash: "hash", full: true },
  };
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
  assert.deepEqual(fork.compaction, original.compaction);
  assert.notEqual(fork.compaction, original.compaction);
  assert.deepEqual(fork.directories, original.directories);
  assert.notEqual(fork.directories, original.directories);
  assert.equal(fork.cwd, original.cwd);
  assert.equal(fork.addDirInitialized, true);
  assert.deepEqual(fork.fileReadState, original.fileReadState);
  assert.notEqual(fork.fileReadState, original.fileReadState);
  fork.messages[0]!.content = "Changed only in the fork";
  fork.compaction!.summary = "Changed only in the fork";
  assert.equal(original.messages[0]?.content, "Keep me");
  assert.equal(original.compaction.summary, "The user asked to be kept.");
  assert.deepEqual((await store.get(fork.id))?.messages, [original.messages[0], banner]);
  assert.equal((await store.get(fork.id))?.compaction?.summary, "The user asked to be kept.");
});

test("rejects invalid session identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  assert.equal(await store.get("../../secret"), null);
});
