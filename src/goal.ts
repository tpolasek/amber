import type { ToolDefinition } from "./types.js";

export const GOAL_COMPLETE_TOOL_NAME = "GoalComplete";

export const GOAL_COMPLETE_TOOL: ToolDefinition = {
  name: GOAL_COMPLETE_TOOL_NAME,
  description: `Clears the session's active goal once it has been fully met.

- Call GoalComplete with an empty input object as soon as the active goal has been achieved.
- A successful call clears the goal immediately and allows one final response with no further goal reminders.
- If the goal was replaced or cleared while you were responding, the call reports that instead of clearing the newer goal.`,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

/** Strict empty-object input: GoalComplete takes no properties at all. */
export function parseGoalCompleteInput(input: Record<string, unknown>): void {
  const keys = Object.keys(input);
  if (keys.length > 0) throw new Error(`GoalComplete accepts no input; got unexpected properties: ${keys.join(", ")}`);
}

export function formatGoalReminder(goal: string): string {
  return `We have a goal set, before you stop make sure that this goal has been met. Once it has been met, run GoalComplete to clear the goal. Goal: "${goal}"`;
}

/** Keeps the formatted reminder below the 32,000-character message boundary. */
export const MAX_GOAL_LENGTH = 30_000;
