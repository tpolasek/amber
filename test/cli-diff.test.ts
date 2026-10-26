// test/cli-diff.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, isDiffCall } from "../src/cli/diff.js";
import { DIM, GREEN, RED } from "../src/cli/render.js";
import type { ToolCall } from "../src/types.js";

function call(name: string, output: string, status: ToolCall["status"] = "complete"): ToolCall {
  return { id: "t1", name, input: {}, status, output };
}

test("only complete Edit/Write calls carrying a unified diff count", () => {
  assert.ok(isDiffCall(call("Edit", "--- a/x\n+++ b/x\n@@\n-x\n+y")));
  assert.ok(isDiffCall(call("Write", "--- /dev/null\n+++ b/x\n@@\n+y")));
  assert.ok(!isDiffCall(call("Bash", "--- a/x\n+++ b/x\n@@\n-x\n+y")));
  assert.ok(!isDiffCall(call("Edit", "updated successfully")));
  assert.ok(!isDiffCall(call("Edit", "--- a/x\n+++ b/x\n@@\n-x\n+y", "error")));
});

test("headers are dropped; hunks and context dim, removals red, additions green", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "",
  ].join("\n");
  assert.deepEqual(diffLines(diff, 80), [
    { text: "  @@ -1,3 +1,3 @@", codes: DIM },
    { text: "   one", codes: DIM },
    { text: "  -two", codes: RED },
    { text: "  +TWO", codes: GREEN },
    { text: "   three", codes: DIM },
  ]);
});

test("a new-file diff is all additions", () => {
  const lines = diffLines("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+fresh\n", 80);
  assert.deepEqual(lines.filter((line) => line.text.includes("fresh")), [{ text: "  +fresh", codes: GREEN }]);
});

test("long lines clip to the terminal width", () => {
  const [line] = diffLines(`+${"x".repeat(100)}`, 22);
  assert.deepEqual(line, { text: `  +${"x".repeat(18)}…`, codes: GREEN });
});

test("wide characters count double when clipping", () => {
  const [line] = diffLines(`+好${"x".repeat(40)}`, 10);
  assert.deepEqual(line, { text: "  +好xxxxxx…", codes: GREEN });
});

test("diffs beyond 400 lines stop with a note", () => {
  const diff = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n");
  const lines = diffLines(diff, 80);
  assert.equal(lines.length, 401);
  assert.ok(lines[0]!.text.includes("line 0"));
  assert.deepEqual(lines.at(-1), { text: "  … 100 more lines", codes: DIM });
});
