// test/cli-tools.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { toolLine, toolStatusRuns } from "../src/cli/tools.js";
import { DARK } from "../src/cli/theme.js";
import type { Run } from "../src/cli/render.js";
import type { ToolCall } from "../src/types.js";

function call(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "t1",
    name: "Bash",
    input: {},
    status: "complete",
    output: "",
    ...overrides,
  };
}

function plain(runs: Run[]): string {
  return runs.map((run) => run.text).join("");
}

test("bash line shows command, exit code, and duration", () => {
  assert.equal(
    plain(toolLine(call({ input: { command: "npm test  --verbose" }, exitCode: 0, durationMs: 2_140 }), DARK)),
    "✓ Bash npm test --verbose · exit 0 · 2.1s",
  );
});

test("the glyph, name, argument, and tail carry distinct colors", () => {
  const runs = toolLine(call({ input: { command: "npm test" }, exitCode: 0, durationMs: 2_140 }), DARK);
  assert.deepEqual(runs.map((run) => run.codes), [
    DARK.toolOk, DARK.toolName, DARK.toolArg, DARK.toolTail, DARK.toolTail, DARK.toolTail, DARK.toolTail,
  ]);
  assert.equal(plain(runs), "✓ Bash npm test · exit 0 · 2.1s");
});

test("a failing exit code colors the tail like an error", () => {
  const runs = toolLine(call({ input: { command: "npm test" }, exitCode: 1, durationMs: 2_140 }), DARK);
  assert.deepEqual(runs.map((run) => run.codes), [
    DARK.toolOk, DARK.toolName, DARK.toolArg, DARK.toolTail, DARK.toolErr, DARK.toolTail, DARK.toolTail,
  ]);
});

test("error tools style the glyph and message with the error color", () => {
  const runs = toolLine(call({ name: "Grep", input: { pattern: "TODO" }, status: "error", output: "boom\nstack" }), DARK);
  assert.deepEqual(runs.map((run) => run.codes), [
    DARK.toolErr, DARK.toolName, DARK.toolArg, DARK.toolTail, DARK.toolErr,
  ]);
  assert.equal(plain(runs), "✗ Grep TODO · boom");
});

test("long commands collapse whitespace and truncate", () => {
  const command = `echo   ${"a".repeat(80)}`;
  const line = plain(toolLine(call({ input: { command } }), DARK));
  assert.ok(line.startsWith("✓ Bash echo aa"));
  assert.ok(line.length <= 60 + "✓ Bash  · exit  · 100.0s".length + 10);
});

test("edit line shows the file path", () => {
  assert.equal(
    plain(toolLine(call({ name: "Edit", input: { file_path: `${homedir()}/repo/src/cli/main.ts` } }), DARK)),
    "✓ Edit ~/repo/src/cli/main.ts",
  );
});

test("file tools report content size in kilotokens instead of elapsed seconds", () => {
  const edit = plain(toolLine(call({
    name: "Edit",
    input: { file_path: "/tmp/x.ts", old_string: "a".repeat(2_000), new_string: "b".repeat(2_000) },
    durationMs: 3,
  }), DARK));
  // 4,009 characters of payload ≈ 1,003 tokens.
  assert.equal(edit, "✓ Edit /tmp/x.ts · 1kt");

  const write = plain(toolLine(call({
    name: "Write",
    input: { file_path: "/tmp/y.ts", content: "c".repeat(12_000) },
    durationMs: 4,
  }), DARK));
  assert.equal(write, "✓ Write /tmp/y.ts · 3kt");

  const read = plain(toolLine(call({
    name: "Read",
    input: { file_path: "/tmp/z.ts" },
    readRange: { startLine: 1, endLine: 40, totalLines: 40 },
    output: "d".repeat(20_000),
    durationMs: 2,
  }), DARK));
  assert.equal(read, "✓ Read /tmp/z.ts L1-40 · 5kt");
});

test("only file tools swap the duration for kilotokens", () => {
  assert.equal(
    plain(toolLine(call({ name: "Grep", input: { pattern: "x" }, output: "hit", durationMs: 1_500 }), DARK)),
    "✓ Grep x · 1.5s",
  );
});

test("read line shows the line range", () => {
  assert.equal(
    plain(toolLine(call({
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
      readRange: { startLine: 3, endLine: 9, totalLines: 40 },
    }), DARK)),
    "✓ Read /tmp/x.ts L3-9",
  );
});

test("timed out bash lines mark it", () => {
  assert.equal(
    plain(toolLine(call({ input: { command: "sleep 9" }, status: "timed_out" }), DARK)),
    "✗ Bash sleep 9 · timed out",
  );
});

test("agent lines show the description", () => {
  assert.equal(
    plain(toolLine(call({ name: "Agent", input: { description: "search the repo" } }), DARK)),
    "✓ Agent search the repo",
  );
});

test("running status is name plus short argument with tool colors", () => {
  const runs = toolStatusRuns(call({ status: "running", input: { command: "npm run build" } }), DARK);
  assert.equal(plain(runs), "Bash npm run build");
  assert.deepEqual(runs.map((run) => run.codes), [DARK.toolName, DARK.toolArg]);
});
