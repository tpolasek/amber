import test from "node:test";
import assert from "node:assert/strict";
import {
  formatGoalReminder,
  GOAL_COMPLETE_TOOL,
  GOAL_COMPLETE_TOOL_NAME,
  MAX_GOAL_LENGTH,
  parseGoalCompleteInput,
} from "../src/goal.js";

test("formats the goal reminder shown to the model", () => {
  assert.equal(
    formatGoalReminder("ship the release"),
    'We have a goal set, before you stop make sure that this goal has been met. Once it has been met, run GoalComplete to clear the goal. Goal: "ship the release"',
  );
  assert.equal(formatGoalReminder(""), 'We have a goal set, before you stop make sure that this goal has been met. Once it has been met, run GoalComplete to clear the goal. Goal: ""');
});

test("the goal limit keeps the reminder below the 32,000-character message boundary", () => {
  assert.ok(MAX_GOAL_LENGTH < 32_000);
  assert.ok(formatGoalReminder("x".repeat(MAX_GOAL_LENGTH)).length < 32_000);
});

test("defines GoalComplete as a strict empty-input tool", () => {
  assert.equal(GOAL_COMPLETE_TOOL_NAME, "GoalComplete");
  assert.equal(GOAL_COMPLETE_TOOL.name, GOAL_COMPLETE_TOOL_NAME);
  assert.deepEqual(GOAL_COMPLETE_TOOL.input_schema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("validates GoalComplete input strictly", () => {
  parseGoalCompleteInput({});
  assert.throws(() => parseGoalCompleteInput({ goal: "done" }), /GoalComplete accepts no input/);
  assert.throws(() => parseGoalCompleteInput({ done: true }), /GoalComplete accepts no input/);
});
