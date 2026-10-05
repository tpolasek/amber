import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundTaskManager } from "../src/background-tasks.js";
import { executeRegularTool, isRegularTool } from "../src/tool-execution.js";
import type { Session, ToolCall } from "../src/types.js";

function fixture() {
  const session: Session = {
    id: "fixture.session.id",
    title: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
  const updates: string[] = [];
  const context = {
    session,
    sessionId: session.id,
    signal: new AbortController().signal,
    allowedDirectories: [process.cwd()],
    currentDirectory: process.cwd(),
    backgroundTasks: new BackgroundTaskManager(),
    backgroundAgentTasks: { task: async () => null },
    onRunning: () => updates.push("running"),
  };
  return { session, updates, context };
}

test("regular tools share running and completion bookkeeping", async () => {
  const { session, updates, context } = fixture();
  const call: ToolCall = {
    id: "task-1",
    name: "TaskCreate",
    input: { subject: "Inspect code", description: "Review the module" },
    status: "queued",
    output: "",
  };
  assert.equal(isRegularTool(call.name), true);
  assert.equal(isRegularTool("Bash"), false);

  const result = await executeRegularTool(call, context);

  assert.deepEqual(updates, ["running"]);
  assert.equal(call.status, "complete");
  assert.ok(call.startedAt);
  assert.ok(call.completedAt);
  assert.equal(typeof call.durationMs, "number");
  assert.equal(result.planningTasksUpdated, true);
  assert.equal(result.waiting, false);
  assert.equal(session.planningTasks?.[0]?.subject, "Inspect code");
});

test("regular tool errors retain a result and completion timestamp", async () => {
  const { updates, context } = fixture();
  const call: ToolCall = { id: "stop-1", name: "TaskStop", input: {}, status: "queued", output: "" };

  const result = await executeRegularTool(call, context);

  assert.deepEqual(updates, ["running"]);
  assert.equal(call.status, "error");
  assert.match(call.output, /Missing required parameter: task_id/);
  assert.equal(result.resultText, call.output);
  assert.ok(call.completedAt);
});
