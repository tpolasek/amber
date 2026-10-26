import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, cliUsageText, matchSessionId } from "../src/cli/main.js";

const env = { AMBER_SERVER: undefined } as NodeJS.ProcessEnv;

const sessions = [
  { id: "abc1234567", title: "One", createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 0, preview: "" },
  { id: "def7654321", title: "Two", createdAt: "2026-01-02", updatedAt: "2026-01-02", messageCount: 0, preview: "" },
];

test("defaults to the local server and two turns of history", () => {
  assert.deepEqual(parseCliArgs([], env), {
    kind: "args",
    args: { server: "http://127.0.0.1:3000", history: 2, list: false },
  });
});

test("AMBER_SERVER overrides the default base url", () => {
  const parsed = parseCliArgs([], { AMBER_SERVER: "http://10.0.0.4:3000" });
  assert.ok(parsed.kind === "args" && parsed.args.server === "http://10.0.0.4:3000");
});

test("parses --server, --history, --list, positional session, and --new with a name", () => {
  const parsed = parseCliArgs(["--server", "http://x:1", "--history", "5", "--list", "ab12"], env);
  assert.ok(parsed.kind === "args");
  assert.deepEqual(parsed.args, { server: "http://x:1", history: 5, list: true, session: "ab12" });
  const created = parseCliArgs(["--new", "my session"], env);
  assert.ok(created.kind === "args" && created.args.newName === "my session");
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
