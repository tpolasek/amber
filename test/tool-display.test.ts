import test from "node:test";
import assert from "node:assert/strict";
import {
  diffLineClass,
  diffSummary,
  isDiffOutput,
  shouldInlineToolSubject,
  shouldRenderToolOutput,
  toolMetadata,
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

test("formats skill tool cards with an output preview", () => {
  const skill = call({
    name: "Skill",
    input: { skill: "/commit", args: "push" },
    output: "",
    statusDisplay: { text: "SKILL LOADED" },
    skillModel: "anthropic/claude-opus-4",
    skillEffort: "high",
  });
  assert.equal(toolSubject(skill), "/commit \"push\"");
  assert.equal(toolSubject(call({ name: "Skill", input: { skill: "/pos-check", args: "test 3434" } })), "/pos-check \"test\" \"3434\"");
  assert.equal(toolSubject(call({ name: "Skill", input: { skill: "pos-check", args: "   " } })), "/pos-check");
  assert.equal(toolSubject(call({ name: "Skill", input: { skill: "pos-check" } })), "/pos-check");
  assert.equal(toolStatusLabel(skill), "SKILL LOADED");
  assert.equal(toolMetadata(skill), "anthropic/claude-opus-4 · effort high");
  assert.equal(shouldRenderToolOutput(skill), false);
  assert.equal(shouldRenderToolOutput(call({ name: "Skill", output: "Computed: 42\nsrc/*.ts files: 37" })), true);
  assert.equal(toolSubject(call({ name: "Skill", input: {} })), "Preparing skill…");

  const failed = call({ name: "Skill", input: { skill: "commit" }, status: "error", statusDisplay: { text: "SKILL FAILED" } });
  assert.equal(toolStatusLabel(failed), "SKILL FAILED");
});

test("formats tool subjects and statuses independently of the DOM", () => {
  assert.equal(toolSubject(call({ input: { command: "npm test" } })), "npm test");
  assert.match(toolSubject(call({ name: "EnterPlanMode" })), /begin planning/);
  assert.match(toolSubject(call({ name: "ExitPlanMode" })), /Review/);
  assert.equal(toolSubject(call({ name: "Glob", input: { pattern: "**/*.ts" } })), "**/*.ts");
  assert.equal(toolSubject(call({ name: "Glob", input: { pattern: "*.md", path: "docs" } })), "*.md in docs");
  assert.equal(toolSubject(call({ name: "Glob", input: {} })), "Preparing glob pattern…");
  assert.equal(shouldInlineToolSubject("npm test"), true);
  assert.equal(shouldInlineToolSubject("first\nsecond"), false);
  assert.equal(toolStatusLabel(call({ status: "running" })), "RUNNING…");
  assert.equal(toolStatusLabel(call({
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    statusDisplay: { text: "RUNNING", appendElapsed: true },
  }), Date.parse("2026-01-01T00:00:02.000Z")), "RUNNING 2.0s");
  assert.equal(toolMetadata(call({
    name: "Agent",
    agentType: "general-purpose",
    agentModel: "mimo-2.5",
  })), "general-purpose · mimo-2.5");
});

test("keeps completed background agent launches labeled as background", () => {
  assert.equal(toolStatusLabel({
    id: "agent-background",
    name: "Agent",
    input: {
      description: "Independent review",
      prompt: "Review the change.",
      run_in_background: true,
    },
    status: "complete",
    output: "Agent running in background",
    durationMs: 25,
    statusDisplay: { text: "BACKGROUND" },
  }), "BACKGROUND");
});
