import test from "node:test";
import assert from "node:assert/strict";
import {
  executeTaskCreate,
  executeTaskGet,
  executeTaskList,
  executeTaskUpdate,
  parseTaskCreateInput,
  parseTaskGetInput,
  parseTaskListInput,
  parseTaskUpdateInput,
} from "../src/planning-task-tools.js";
import type { Session } from "../src/types.js";

function session(): Session {
  return {
    id: "task.test.session",
    title: "Tasks",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    messages: [],
  };
}

test("TaskCreate applies defaults and allocates ascending string IDs", () => {
  const current = session();
  const first = executeTaskCreate(current, parseTaskCreateInput({
    subject: "Fix authentication",
    description: "Handle an empty email field",
  }));
  const second = executeTaskCreate(current, parseTaskCreateInput({
    subject: "Add tests",
    description: "Cover the login fix",
    activeForm: "Adding tests",
    metadata: { priority: "high" },
  }));

  assert.deepEqual(first.data, {
    id: "1",
    subject: "Fix authentication",
    description: "Handle an empty email field",
    status: "pending",
    owner: "",
    blocks: [],
    blockedBy: [],
    metadata: {},
  });
  assert.equal(second.data.id, "2");
  assert.deepEqual(second.data.metadata, { priority: "high" });
  assert.equal(current.planningTasks?.[0]?.activeForm, "Fix authentication");
  assert.equal(current.planningTasks?.[1]?.activeForm, "Adding tests");
  assert.equal(first.resultText, JSON.stringify(first.data));
});

test("TaskGet returns full details and a benign not-found result", () => {
  const current = session();
  executeTaskCreate(current, parseTaskCreateInput({ subject: "Inspect task", description: "Read every field" }));

  assert.deepEqual(executeTaskGet(current, parseTaskGetInput({ taskId: "1" })).data, {
    id: "1",
    subject: "Inspect task",
    description: "Read every field",
    status: "pending",
    owner: "",
    blocks: [],
    blockedBy: [],
    metadata: {},
  });
  assert.deepEqual(executeTaskGet(current, "999"), {
    data: null,
    output: "Task not found",
    resultText: "Task not found",
  });
});

test("TaskUpdate merges fields and creates reciprocal dependencies", () => {
  const current = session();
  executeTaskCreate(current, parseTaskCreateInput({
    subject: "Prepare schema",
    description: "Create the schema",
    metadata: { priority: "low", component: "db" },
  }));
  executeTaskCreate(current, parseTaskCreateInput({ subject: "Build API", description: "Use the schema" }));

  const updated = executeTaskUpdate(current, parseTaskUpdateInput({
    taskId: "2",
    status: "in_progress",
    owner: "agent-1",
    addBlockedBy: ["1", "1"],
    metadata: { priority: "critical", removeMe: null },
  }));
  executeTaskUpdate(current, parseTaskUpdateInput({
    taskId: "1",
    metadata: { priority: null, component: "database" },
  }));

  assert.equal(updated.data?.status, "in_progress");
  assert.equal(updated.data?.owner, "agent-1");
  assert.deepEqual(updated.data?.blockedBy, ["1"]);
  assert.deepEqual(executeTaskGet(current, "1").data, {
    id: "1",
    subject: "Prepare schema",
    description: "Create the schema",
    status: "pending",
    owner: "",
    blocks: ["2"],
    blockedBy: [],
    metadata: { component: "database" },
  });
});

test("TaskList is ID-sorted, summarized, and excludes completed blockers", () => {
  const current = session();
  executeTaskCreate(current, parseTaskCreateInput({ subject: "First", description: "First task" }));
  executeTaskCreate(current, parseTaskCreateInput({ subject: "Second", description: "Second task" }));
  executeTaskUpdate(current, parseTaskUpdateInput({ taskId: "2", addBlockedBy: ["1"] }));

  assert.deepEqual(executeTaskList(current).data, [
    { id: "1", subject: "First", status: "pending", owner: "", blockedBy: [] },
    { id: "2", subject: "Second", status: "pending", owner: "", blockedBy: ["1"] },
  ]);
  executeTaskUpdate(current, parseTaskUpdateInput({ taskId: "1", status: "completed" }));
  assert.deepEqual(executeTaskList(current).data[1]?.blockedBy, []);
});

test("TaskUpdate deletion removes dependencies and never reuses an ID", () => {
  const current = session();
  executeTaskCreate(current, parseTaskCreateInput({ subject: "Blocker", description: "Block another task" }));
  executeTaskCreate(current, parseTaskCreateInput({ subject: "Blocked", description: "Wait for blocker" }));
  executeTaskUpdate(current, parseTaskUpdateInput({ taskId: "2", addBlockedBy: ["1"] }));

  const deleted = executeTaskUpdate(current, parseTaskUpdateInput({ taskId: "1", status: "deleted" }));
  assert.equal(deleted.data?.status, "deleted");
  assert.equal(executeTaskGet(current, "1").data, null);
  assert.deepEqual(executeTaskGet(current, "2").data?.blockedBy, []);

  const next = executeTaskCreate(current, parseTaskCreateInput({ subject: "Replacement", description: "New work" }));
  assert.equal(next.data.id, "3");
});

test("task input parsers reject invalid values", () => {
  assert.throws(() => parseTaskCreateInput({ subject: "", description: "work" }), /subject/);
  assert.throws(() => parseTaskGetInput({ taskId: 1 }), /taskId/);
  assert.throws(() => parseTaskListInput({ unexpected: true }), /does not accept/);
  assert.throws(() => parseTaskUpdateInput({ taskId: "1", status: "open" }), /status/);
  assert.throws(() => parseTaskUpdateInput({ taskId: "1", addBlocks: [2] }), /task ID/);
});
