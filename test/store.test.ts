import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store.js";
import { BASIC_ENGLISH_2000 } from "../src/basic-english-2000.js";

function userMessage(id: string, content: string): import("../src/types.js").Message {
  return { id, role: "user", content, createdAt: new Date().toISOString(), status: "complete" };
}

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
  session.invokedSkills = [{
    name: "commit",
    path: "/tmp/commit/SKILL.md",
    content: "commit instructions",
    invokedAt: new Date().toISOString(),
  }];
  session.cacheUsageResetThroughMessageId = "message-1";
  session.skillTouchedPaths = ["/tmp/file.txt"];
  session.goal = "make the release green";
  await store.save(session);

  const cleared = await store.clear(session);
  assert.equal(cleared.id, session.id);
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.compaction, undefined);
  assert.equal(cleared.fileReadState, undefined);
  assert.equal(cleared.cacheUsageResetThroughMessageId, undefined);
  assert.equal(cleared.invokedSkills, undefined);
  assert.equal(cleared.skillTouchedPaths, undefined);
  assert.equal(cleared.skillRoots, undefined);
  assert.equal(cleared.goal, undefined);
  assert.deepEqual((await store.get(session.id))?.messages, []);
  // A fresh process must not resurrect the cleared history from the log.
  const reopened = new SessionStore(directory);
  await reopened.initialize();
  assert.deepEqual((await reopened.get(session.id))?.messages, []);
  assert.deepEqual(await reopened.list().then((entries) => entries[0]?.preview), "No messages yet");
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
  original.model = "zai/glm-5.3";
  original.thinkingLevel = "high";
  original.fileReadState = {
    "/tmp/example-workspace/file.txt": { mtimeMs: 1, size: 4, hash: "hash", full: true },
  };
  original.skillRoots = ["/tmp/example-workspace/packages/nested"];
  original.skillTouchedPaths = ["/tmp/example-workspace/file.txt"];
  original.goal = "make the release green";
  original.invokedSkills = [{
    name: "commit",
    path: "/tmp/example-workspace/.amber/skills/commit/SKILL.md",
    content: "commit instructions",
    invokedAt: new Date().toISOString(),
  }];
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
  assert.equal(fork.goal, undefined);
  assert.deepEqual(fork.directories, original.directories);
  assert.notEqual(fork.directories, original.directories);
  assert.equal(fork.cwd, original.cwd);
  assert.equal(fork.addDirInitialized, true);
  assert.equal(fork.model, "zai/glm-5.3");
  assert.equal(fork.thinkingLevel, "high");
  assert.deepEqual(fork.fileReadState, original.fileReadState);
  assert.notEqual(fork.fileReadState, original.fileReadState);
  assert.deepEqual(fork.skillRoots, original.skillRoots);
  assert.deepEqual(fork.skillTouchedPaths, original.skillTouchedPaths);
  assert.deepEqual(fork.invokedSkills, original.invokedSkills);
  assert.notEqual(fork.invokedSkills, original.invokedSkills);
  fork.invokedSkills![0]!.content = "Changed only in the fork";
  fork.messages[0]!.content = "Changed only in the fork";
  fork.compaction!.summary = "Changed only in the fork";
  assert.equal(original.messages[0]?.content, "Keep me");
  assert.equal(original.compaction.summary, "The user asked to be kept.");
  assert.equal(original.invokedSkills?.[0]?.content, "commit instructions");
  // The cached fork object carries the unsaved edits; a fresh store proves the
  // persisted fork is independent of both the original and those edits.
  const reopened = new SessionStore(directory);
  await reopened.initialize();
  assert.deepEqual((await reopened.get(fork.id))?.messages, [original.messages[0], banner]);
  assert.equal((await reopened.get(fork.id))?.compaction?.summary, "The user asked to be kept.");
});

test("persists the session goal across reopening, while clear removes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  session.goal = "make the release green";
  session.goalSetAt = "2026-09-15T00:00:00.000Z";
  await store.saveMeta(session);

  const reopened = new SessionStore(directory);
  await reopened.initialize();
  const loaded = await reopened.get(session.id);
  assert.equal(loaded?.goal, "make the release green");
  assert.equal(loaded?.goalSetAt, "2026-09-15T00:00:00.000Z");

  const cleared = await reopened.clear(loaded!);
  assert.equal(cleared.goal, undefined);
  assert.equal(cleared.goalSetAt, undefined);
  const afterClear = new SessionStore(directory);
  await afterClear.initialize();
  assert.equal((await afterClear.get(session.id))?.goal, undefined);
});

test("rejects invalid session identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  assert.equal(await store.get("../../secret"), null);
});

test("creates linked agent sub-sessions using the parent id and a short uuid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const parent = await store.create();
  parent.directories = ["/tmp/example-workspace"];
  parent.cwd = "/tmp/example-workspace";
  parent.model = "zai/glm-5.3";
  parent.skillRoots = ["/tmp/example-workspace/packages/nested"];
  parent.skillTouchedPaths = ["/tmp/example-workspace/packages/nested/src/file.ts"];
  await store.save(parent);

  const child = await store.createAgentSession(parent, "code-review", "Review latest diff", undefined, "high");
  assert.match(child.id, new RegExp(`^${parent.id.replaceAll(".", "\\.")}\\.[a-z0-9]{8}$`));
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.agentType, "code-review");
  assert.equal(child.agentStatus, "running");
  assert.equal(child.title, "Review latest diff");
  assert.equal(child.model, "zai/glm-5.3");
  assert.equal(child.thinkingLevel, "high");
  assert.equal(child.messages[0]?.kind, "agent-banner");
  assert.equal(child.messages[0]?.sourceSessionId, parent.id);
  assert.deepEqual(child.directories, parent.directories);
  assert.deepEqual(child.skillRoots, parent.skillRoots);
  assert.notEqual(child.skillRoots, parent.skillRoots);
  assert.deepEqual(child.skillTouchedPaths, parent.skillTouchedPaths);
  assert.notEqual(child.skillTouchedPaths, parent.skillTouchedPaths);
  assert.equal((await store.get(child.id))?.parentSessionId, parent.id);
  assert.equal((await store.get(child.id))?.thinkingLevel, "high");
  assert.deepEqual((await store.list()).map((session) => session.id), [parent.id]);
});

test("lists direct agent sub-sessions with their persisted status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const parent = await store.create();
  const first = await store.createAgentSession(parent, "general-purpose", "Research the API");
  const second = await store.createAgentSession(parent, "code-review", "Review the patch");
  const nested = await store.createAgentSession(first, "general-purpose", "Nested agent");
  first.agentStatus = "complete";
  second.agentStatus = "error";
  nested.agentStatus = "stopped";
  await Promise.all([store.save(first), store.save(second), store.save(nested)]);

  const agents = await store.listAgents(parent.id);
  assert.deepEqual(new Set(agents), new Set([
    { id: first.id, description: "Research the API", status: "complete" },
    { id: second.id, description: "Review the patch", status: "error" },
  ]));
  assert.equal(agents.some((agent) => agent.id === nested.id), false);
  assert.deepEqual(await store.listAgents("missing.session.id"), []);
});

test("resolves a complete root session family from the root or a nested agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const root = await store.create();
  const firstAgent = await store.createAgentSession(root, "general-purpose", "First agent");
  const siblingAgent = await store.createAgentSession(root, "code-review", "Sibling agent");
  const nestedAgent = await store.createAgentSession(firstAgent, "general-purpose", "Nested agent");
  const unrelated = await store.create();

  const expected = new Set([root.id, firstAgent.id, siblingAgent.id, nestedAgent.id]);
  assert.deepEqual(new Set((await store.family(root.id)).map((session) => session.id)), expected);
  assert.deepEqual(new Set((await store.family(nestedAgent.id)).map((session) => session.id)), expected);
  assert.equal((await store.family(root.id)).some((session) => session.id === unrelated.id), false);
  assert.deepEqual(await store.family("missing.session.id"), []);
});

test("persists, forks, inherits, clears, and deletes plan mode state and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "amber-store-plan-"));
  const sessionDirectory = join(root, "sessions");
  const planDirectory = join(root, "plans");
  const store = new SessionStore(sessionDirectory, planDirectory);
  await store.initialize();
  const session = await store.create();
  const sourcePlanPath = join(planDirectory, `${session.id}.md`);
  session.planMode = { active: true, planFilePath: sourcePlanPath };
  await writeFile(sourcePlanPath, "# Source plan\n", "utf8");
  await store.save(session);

  assert.deepEqual((await store.get(session.id))?.planMode, session.planMode);
  const child = await store.createAgentSession(session, "general-purpose", "Explore plan");
  assert.deepEqual(child.planMode, session.planMode);
  assert.notEqual(child.planMode, session.planMode);

  const banner = {
    id: "banner-plan",
    role: "assistant" as const,
    content: `Forked from session: ${session.id}`,
    createdAt: new Date().toISOString(),
    status: "complete" as const,
    kind: "fork-banner" as const,
    sourceSessionId: session.id,
  };
  const fork = await store.createFork(session, banner);
  assert.equal(fork.planMode?.active, true);
  assert.notEqual(fork.planMode?.planFilePath, sourcePlanPath);
  assert.equal(await readFile(fork.planMode!.planFilePath, "utf8"), "# Source plan\n");
  await writeFile(fork.planMode!.planFilePath, "# Fork plan\n", "utf8");
  assert.equal(await readFile(sourcePlanPath, "utf8"), "# Source plan\n");

  const forkPlanPath = fork.planMode!.planFilePath;
  await store.clear(fork);
  assert.equal(fork.planMode, undefined);
  assert.equal(await readFile(forkPlanPath, "utf8"), "# Fork plan\n");

  assert.equal(await store.remove(session.id), true);
  await assert.rejects(stat(sourcePlanPath), { code: "ENOENT" });
  assert.equal(await store.remove(fork.id), true);
  await assert.rejects(stat(forkPlanPath), { code: "ENOENT" });
});

test("creates a linked plan implementation session with fresh history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-plan-impl-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const source = await store.create();
  source.directories = ["/tmp/example-workspace"];
  source.cwd = "/tmp/example-workspace/subdirectory";
  source.addDirInitialized = true;
  source.thinkingLevel = "xhigh";
  source.planMode = { active: true, planFilePath: join(dirname(directory), "plans", `${source.id}.md`) };
  source.messages.push({
    id: "message-1", role: "user", content: "Plan this feature", createdAt: new Date().toISOString(), status: "complete",
  });
  await store.save(source);
  const banner = {
    id: "banner-plan-impl",
    role: "assistant" as const,
    content: `Plan from session: ${source.id}`,
    createdAt: new Date().toISOString(),
    status: "complete" as const,
    kind: "plan-banner" as const,
    sourceSessionId: source.id,
  };

  const implementation = await store.createPlanImplementation(source, banner);
  assert.notEqual(implementation.id, source.id);
  assert.deepEqual(implementation.messages, [banner]);
  assert.deepEqual(implementation.directories, source.directories);
  assert.equal(implementation.cwd, source.cwd);
  assert.equal(implementation.thinkingLevel, "xhigh");
  assert.equal(implementation.addDirInitialized, true);
  assert.equal(implementation.planMode, undefined);
  assert.equal(implementation.parentSessionId, undefined);
  assert.equal(source.messages.length, 1);
  assert.deepEqual((await store.get(implementation.id))?.messages, [banner]);
  assert.deepEqual(new Set((await store.list()).map((session) => session.id)), new Set([implementation.id, source.id]));
});

test("appends, updates, and inserts replay in order for a fresh process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-ops-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();

  const user = userMessage("user-1", "Hello");
  const assistant: import("../src/types.js").Message = { id: "assistant-1", role: "assistant", content: "", createdAt: new Date().toISOString(), status: "streaming" };
  await store.appendMessages(session, [user, assistant]);

  assistant.content = "Working on it";
  assistant.status = "complete";
  await store.updateMessage(session, assistant);

  session.title = "Renamed";
  await store.saveMeta(session);

  const notification = { ...userMessage("notification-1", "<task-notification>done</task-notification>"), kind: "agent-notification" as const };
  await store.insertMessages(session, assistant.id, [notification]);

  const followUp = userMessage("user-2", "Thanks");
  await store.appendMessages(session, [followUp]);
  assert.deepEqual(session.messages.map((message) => message.id), ["user-1", "notification-1", "assistant-1", "user-2"]);

  // A second store instance is a server restart: the log must replay exactly.
  const restarted = new SessionStore(directory);
  await restarted.initialize();
  const loaded = await restarted.get(session.id);
  assert.deepEqual(loaded?.messages.map((message) => message.id), ["user-1", "notification-1", "assistant-1", "user-2"]);
  assert.equal(loaded?.messages[2]?.content, "Working on it");
  assert.equal(loaded?.messages[2]?.status, "complete");
  assert.equal(loaded?.title, "Renamed");
  assert.deepEqual(await restarted.list().then((entries) => entries[0]?.preview), "Thanks");
});

test("keeps a bounded cache and returns the live object on repeated gets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-cache-"));
  const store = new SessionStore(directory, undefined, 2);
  await store.initialize();
  const first = await store.create();
  const second = await store.create();
  const third = await store.create();
  // Creating third evicted first (the least recently used) from the cache.

  assert.equal(await store.get(third.id), third);
  const reloadedFirst = await store.get(first.id);
  assert.notEqual(reloadedFirst, first);
  assert.deepEqual(reloadedFirst?.messages, first.messages);
  // The reloaded copy is now cached and stable across gets.
  assert.equal(await store.get(first.id), reloadedFirst);
  // Accessing first evicted second; it reloads from disk identically.
  const reloadedSecond = await store.get(second.id);
  assert.notEqual(reloadedSecond, second);
  assert.equal(reloadedSecond?.id, second.id);
});

test("collapses a log swollen by streaming checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-compaction-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  const user = userMessage("user-1", "Stream something long");
  const assistant: import("../src/types.js").Message = { id: "assistant-1", role: "assistant", content: "", createdAt: new Date().toISOString(), status: "streaming" };
  await store.appendMessages(session, [user, assistant]);

  for (let index = 0; index < 600; index += 1) {
    assistant.content = `progress ${index}`;
    await store.updateMessage(session, assistant);
  }
  const logPath = join(directory, `${session.id}.log.jsonl`);
  const compacted = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.ok(compacted.length < 100, `expected the log to be compacted, got ${compacted.length} lines`);

  const restarted = new SessionStore(directory);
  await restarted.initialize();
  const loaded = await restarted.get(session.id);
  assert.equal(loaded?.messages[1]?.content, "progress 599");
});

test("repairs a torn final log line so the next append survives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-torn-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  const user = userMessage("user-1", "Survivor");
  await store.appendMessages(session, [user]);

  // A crash mid-append leaves a partial final line with no trailing newline.
  const logPath = join(directory, `${session.id}.log.jsonl`);
  await writeFile(logPath, `${await readFile(logPath, "utf8")}\n{"op":"add","message":{"id":"torn"`, "utf8");

  const restarted = new SessionStore(directory);
  await restarted.initialize();
  const loaded = await restarted.get(session.id);
  assert.deepEqual(loaded?.messages.map((message) => message.id), ["user-1"]);

  // The follow-up message must not merge onto the torn bytes and vanish.
  const followUp = userMessage("user-2", "After the crash");
  await restarted.appendMessages(loaded!, [followUp]);

  const reopened = new SessionStore(directory);
  await reopened.initialize();
  assert.deepEqual(
    (await reopened.get(session.id))?.messages.map((message) => message.id),
    ["user-1", "user-2"],
  );
});

test("searches session contents and returns the first matching excerpt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const alpha = await store.create();
  alpha.title = "Alpha";
  await store.appendMessages(alpha, [userMessage("a1", "The quick brown fox jumps over the lazy dog")]);
  const beta = await store.create();
  beta.title = "Beta";
  await store.appendMessages(beta, [userMessage("b1", "An unrelated note about cats")]);

  const hits = await store.search("LAZY");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, alpha.id);
  assert.equal(hits[0]?.match?.includes("lazy"), true);
  assert.match(hits[0]?.match ?? "", /quick brown fox/);

  assert.deepEqual(await store.search("zebra"), []);
  // A title match needs no excerpt; the title is already visible.
  beta.title = "Lazy afternoon";
  await store.saveMeta(beta);
  const metadataHits = await store.search("afternoon");
  assert.equal(metadataHits.length, 1);
  assert.equal(metadataHits[0]?.match, undefined);
});

test("content search scans assistant text, ignores agent sub-sessions, and honors the limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-scan-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  await store.appendMessages(session, [{
    id: "assistant-1",
    role: "assistant",
    content: "Deploying the widget service now",
    createdAt: new Date().toISOString(),
    status: "complete",
  }]);
  const agent = await store.createAgentSession(session, "general-purpose", "Inspect widget logs");
  agent.messages.push(userMessage("agent-1", "widget internals"));
  await store.save(agent);

  const hits = await store.search("widget");
  assert.deepEqual(hits.map((hit) => hit.id), [session.id]);
  assert.match(hits[0]?.match ?? "", /widget/);
  assert.deepEqual(await store.search("widget", 0), []);
  assert.equal((await store.search("widget", 1)).length, 1);

  // An empty or whitespace query is the plain session list.
  assert.deepEqual((await store.search("   ")).map((hit) => hit.id), (await store.list()).map((hit) => hit.id));
});

test("content search finds sessions outside the archive's recent list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-older-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const old = await store.create();
  await store.appendMessages(old, [userMessage("old", `${"x".repeat(130)} rare archive phrase`)]);
  const oldMetaPath = join(directory, `${old.id}.meta.json`);
  const oldMeta = JSON.parse(await readFile(oldMetaPath, "utf8")) as { updatedAt: string };
  oldMeta.updatedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(oldMetaPath, JSON.stringify(oldMeta));
  for (let index = 0; index < 30; index += 1) await store.create();
  assert.equal((await store.list()).some((summary) => summary.id === old.id), false);
  assert.equal((await store.search("rare archive phrase"))[0]?.id, old.id);
  assert.equal((await store.search("RARE ARCHIVE PHRASE"))[0]?.id, old.id);
});

test("content search ignores replaced and cleared log text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-updates-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  const message = userMessage("m1", "obsolete phrase");
  await store.appendMessages(session, [message]);
  message.content = "current phrase";
  await store.updateMessage(session, message);

  const reopened = new SessionStore(directory);
  await reopened.initialize();
  assert.deepEqual(await reopened.search("obsolete"), []);
  assert.equal((await reopened.search("current"))[0]?.id, session.id);

  await store.save({ ...session, messages: [] });
  const cleared = new SessionStore(directory);
  await cleared.initialize();
  assert.deepEqual(await cleared.search("current"), []);
});

test("content search handles quoted and literal punctuation in uncached logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-quoted-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  await store.appendMessages(session, [userMessage("m1", `${"x".repeat(130)} "router [test]"`)]);
  const reopened = new SessionStore(directory);
  await reopened.initialize();
  assert.equal((await reopened.search('"router [test]"'))[0]?.id, session.id);
});

test("content search excerpt is bounded and marks clipped context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-search-excerpt-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  await store.appendMessages(session, [userMessage("m1", `${"x".repeat(300)} needle ${"y".repeat(300)}`)]);

  const [hit] = await store.search("needle");
  assert.ok(hit?.match);
  assert.ok(hit.match.includes("needle"));
  assert.ok(hit.match.length <= 204, `excerpt too long: ${hit.match.length}`);
  assert.match(hit.match, /^…/);
  assert.match(hit.match, /…$/);
});

test("stores metadata and messages in separate files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-store-files-"));
  const store = new SessionStore(directory);
  await store.initialize();
  const session = await store.create();
  const user = userMessage("user-1", "Split storage");
  await store.appendMessages(session, [user]);

  const metadata = JSON.parse(await readFile(join(directory, `${session.id}.meta.json`), "utf8")) as Record<string, unknown>;
  assert.equal("messages" in metadata, false);
  assert.equal(metadata.messageCount, 1);
  assert.equal(metadata.preview, "Split storage");
  const log = await readFile(join(directory, `${session.id}.log.jsonl`), "utf8");
  assert.match(log, /^\{"op":"add","message":\{"id":"user-1"/);
});
