import test from "node:test";
import assert from "node:assert/strict";
import {
  diffLineClass,
  diffSummary,
  isDiffOutput,
  shouldInlineToolSubject,
  shouldRenderToolOutput,
  toolStatusLabel,
  toolSubject,
} from "../src/tool-display.js";
import type { ToolCall } from "../src/types.js";

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "tool-1", name: "Bash", input: {}, status: "complete", output: "", ...overrides };
}

test("classifies and summarizes tool output for display", () => {
  const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";
  assert.equal(isDiffOutput(call({ name: "Edit", output: diff })), true);
  assert.equal(diffSummary(diff), "Diff · +1 −1");
  assert.equal(diffLineClass("@@ -1 +1 @@"), "diff-hunk");
  assert.equal(diffLineClass("+new"), "diff-addition");
  assert.equal(shouldRenderToolOutput(call({ output: "(no output)" })), false);
  assert.equal(shouldRenderToolOutput(call({ output: "done" })), true);
  assert.equal(shouldRenderToolOutput(call({ name: "EnterPlanMode", output: "internal result" })), false);
  assert.equal(shouldRenderToolOutput(call({ name: "ExitPlanMode", output: "reviewed plan" })), false);
});

test("formats tool subjects and statuses independently of the DOM", () => {
  assert.equal(toolSubject(call({ input: { command: "npm test" } })), "npm test");
  assert.match(toolSubject(call({ name: "EnterPlanMode" })), /begin planning/);
  assert.match(toolSubject(call({ name: "ExitPlanMode" })), /Review/);
  assert.equal(shouldInlineToolSubject("npm test"), true);
  assert.equal(shouldInlineToolSubject("first\nsecond"), false);
  assert.equal(toolStatusLabel(call({ status: "running" })), "RUNNING…");
  assert.equal(toolStatusLabel(call({
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    statusDisplay: { text: "RUNNING", appendElapsed: true },
  }), Date.parse("2026-01-01T00:00:02.000Z")), "RUNNING 2.0s");
});
