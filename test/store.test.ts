import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
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
  session.invokedSkills = [{
    name: "commit",
    path: "/tmp/commit/SKILL.md",
    content: "commit instructions",
    invokedAt: new Date().toISOString(),
  }];
  session.skillTouchedPaths = ["/tmp/file.txt"];
  await store.save(session);

  const cleared = await store.clear(session);
  assert.equal(cleared.id, session.id);
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.compaction, undefined);
  assert.equal(cleared.fileReadState, undefined);
  assert.equal(cleared.invokedSkills, undefined);
  assert.equal(cleared.skillTouchedPaths, undefined);
  assert.equal(cleared.skillRoots, undefined);
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
  original.model = "zai/glm-5.3";
  original.thinkingLevel = "high";
  original.fileReadState = {
    "/tmp/example-workspace/file.txt": { mtimeMs: 1, size: 4, hash: "hash", full: true },
  };
  original.skillRoots = ["/tmp/example-workspace/packages/nested"];
  original.skillTouchedPaths = ["/tmp/example-workspace/file.txt"];
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
  assert.deepEqual((await store.get(fork.id))?.messages, [original.messages[0], banner]);
  assert.equal((await store.get(fork.id))?.compaction?.summary, "The user asked to be kept.");
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

  const child = await store.createAgentSession(parent, "code-review", "Review latest diff");
  assert.match(child.id, new RegExp(`^${parent.id.replaceAll(".", "\\.")}\\.[a-z0-9]{8}$`));
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.agentType, "code-review");
  assert.equal(child.agentStatus, "running");
  assert.equal(child.title, "Review latest diff");
  assert.equal(child.model, "zai/glm-5.3");
  assert.equal(child.messages[0]?.kind, "agent-banner");
  assert.equal(child.messages[0]?.sourceSessionId, parent.id);
  assert.deepEqual(child.directories, parent.directories);
  assert.deepEqual(child.skillRoots, parent.skillRoots);
  assert.notEqual(child.skillRoots, parent.skillRoots);
  assert.deepEqual(child.skillTouchedPaths, parent.skillTouchedPaths);
  assert.notEqual(child.skillTouchedPaths, parent.skillTouchedPaths);
  assert.equal((await store.get(child.id))?.parentSessionId, parent.id);
  assert.deepEqual((await store.list()).map((session) => session.id), [parent.id]);
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
