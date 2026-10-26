import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, cliUsageText, matchSessionId, matchModel } from "../src/cli/main.js";

const env = { AMBER_SERVER: undefined } as NodeJS.ProcessEnv;

const sessions = [
  { id: "abc1234567", title: "One", createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 0, preview: "" },
  { id: "def7654321", title: "Two", createdAt: "2026-01-02", updatedAt: "2026-01-02", messageCount: 0, preview: "" },
];

test("defaults to the local server and two turns of history", () => {
  assert.deepEqual(parseCliArgs([], env), {
    kind: "args",
    args: { server: "http://127.0.0.1:3000", history: 2, list: false, thinking: false },
  });
});

test("AMBER_SERVER overrides the default base url", () => {
  const parsed = parseCliArgs([], { AMBER_SERVER: "http://10.0.0.4:3000" });
  assert.ok(parsed.kind === "args" && parsed.args.server === "http://10.0.0.4:3000");
});

test("parses --server, --history, --list, positional session, and --new with a name", () => {
  const parsed = parseCliArgs(["--server", "http://x:1", "--history", "5", "--list", "ab12"], env);
  assert.ok(parsed.kind === "args");
  assert.deepEqual(parsed.args, {
    server: "http://x:1", history: 5, list: true, thinking: false, session: "ab12",
  });
  const created = parseCliArgs(["--new", "my session"], env);
  assert.ok(created.kind === "args" && created.args.newName === "my session");
});

test("--thinking streams thinking text", () => {
  const parsed = parseCliArgs(["--thinking"], env);
  assert.ok(parsed.kind === "args" && parsed.args.thinking === true);
});

test("--new without a name still parses", () => {
  const parsed = parseCliArgs(["--new"], env);
  assert.ok(parsed.kind === "args" && parsed.args.newName === "");
});

test("--help wins and unknown options throw", () => {
  assert.deepEqual(parseCliArgs(["--history", "3", "--help"], env), { kind: "help" });
  assert.throws(() => parseCliArgs(["--wat"], env), /unknown option/);
  assert.throws(() => parseCliArgs(["--history", "x"], env), /--history/);
  assert.ok(cliUsageText().includes("amber cli"));
});

test("a session id prefix resolves to its unique match", () => {
  assert.equal(matchSessionId(sessions, "abc1234567"), "abc1234567");
  assert.equal(matchSessionId(sessions, "def"), "def7654321");
  assert.throws(() => matchSessionId(sessions, "zzz"), /no session matches 'zzz'/);
  assert.throws(() => matchSessionId(sessions, ""), /ambiguous/);
});

const models = [
  { key: "openai/gpt-5.3", model: "gpt-5.3", displayName: "GPT-5.3", thinkingLevel: "medium" },
  { key: "openai/gpt-5.3-mini", model: "gpt-5.3-mini", displayName: "GPT-5.3 Mini", thinkingLevel: "low" },
  { key: "mock/mock-model", model: "mock-model", displayName: "mock-model", thinkingLevel: "none" },
] as const;

test("a model query resolves by exact key or id before unique prefix", () => {
  assert.equal(matchModel([...models], "openai/gpt-5.3").key, "openai/gpt-5.3");
  assert.equal(matchModel([...models], "gpt-5.3").key, "openai/gpt-5.3");
  assert.equal(matchModel([...models], "mock").key, "mock/mock-model");
  assert.throws(() => matchModel([...models], "gpt-4"), /no model matches/);
  assert.throws(() => matchModel([...models], "gpt"), /'gpt' is ambiguous/);
  assert.throws(() => matchModel([...models], "zzz"), /no model matches 'zzz'/);
});
