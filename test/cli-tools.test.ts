// test/cli-tools.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { toolLine, toolStatus } from "../src/cli/tools.js";
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

test("bash line shows command, exit code, and duration", () => {
  assert.equal(
    toolLine(call({ input: { command: "npm test  --verbose" }, exitCode: 0, durationMs: 2_140 })),
    "✓ Bash npm test --verbose · exit 0 · 2.1s",
  );
});

test("long commands collapse whitespace and truncate", () => {
  const command = `echo   ${"a".repeat(80)}`;
  assert.ok(toolLine(call({ input: { command } })).startsWith("✓ Bash echo aa"));
  assert.ok(toolLine(call({ input: { command } })).length <= 60 + "✓ Bash  · exit  · 100.0s".length + 10);
});

test("edit line shows the file path", () => {
  assert.equal(toolLine(call({ name: "Edit", input: { file_path: `${homedir()}/repo/src/cli/main.ts` } })),
    "✓ Edit ~/repo/src/cli/main.ts");
});

test("read line shows the line range", () => {
  assert.equal(
    toolLine(call({
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
      readRange: { startLine: 3, endLine: 9, totalLines: 40 },
    })),
    "✓ Read /tmp/x.ts L3-9",
  );
});

test("error tools show the first output line", () => {
  assert.equal(
    toolLine(call({ name: "Grep", input: { pattern: "TODO" }, status: "error", output: "boom\nstack" })),
    "✗ Grep TODO · boom",
  );
});

test("timed out bash lines mark it", () => {
  assert.equal(
    toolLine(call({ input: { command: "sleep 9" }, status: "timed_out" })),
    "✗ Bash sleep 9 · timed out",
  );
});

test("agent lines show the description", () => {
  assert.equal(
    toolLine(call({ name: "Agent", input: { description: "search the repo" } })),
    "✓ Agent search the repo",
  );
});

test("running status is name plus short argument", () => {
  assert.equal(toolStatus(call({ status: "running", input: { command: "npm run build" } })), "Bash npm run build");
});
