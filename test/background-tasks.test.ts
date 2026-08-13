import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskManager } from "../src/background-tasks.js";
import {
  executeTaskOutput,
  executeTaskStop,
  parseTaskOutputInput,
  parseTaskStopInput,
} from "../src/task-tools.js";

test("background Bash returns immediately and TaskOutput waits for stdout and stderr", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const task = await manager.start("session-one", {
    command: "sleep 0.1; printf out; printf err >&2",
    description: "Emit task output",
    timeoutMs: 2_000,
    runInBackground: true,
  }, [directory]);

  assert.match(task.id, /^b[0-9a-z]{8}$/);
  assert.equal(task.status, "running");
  assert.equal(task.description, "Emit task output");

  const pending = await manager.output("session-one", task.id, false, 0);
  assert.equal(pending.retrievalStatus, "not_ready");
  assert.equal(pending.task.status, "running");

  const result = await executeTaskOutput(manager, "session-one", {
    taskId: task.id, block: true, timeoutMs: 2_000,
  });
  assert.match(result.output, /status: completed/);
  assert.match(result.output, /stdout:\nout/);
  assert.match(result.output, /stderr:\nerr/);
  assert.match(result.resultText, /<retrieval_status>success<\/retrieval_status>/);
  assert.match(result.resultText, /<task_type>local_bash<\/task_type>/);
  assert.match(result.resultText, /<exit_code>0<\/exit_code>/);
  assert.match(result.resultText, /<output>\nout\nerr\n<\/output>/);
});

test("TaskOutput times out without stopping a task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const task = await manager.start("session-one", {
    command: "sleep 0.2; printf done", timeoutMs: 2_000, runInBackground: true,
  }, [directory]);
  const result = await manager.output("session-one", task.id, true, 10);
  assert.equal(result.retrievalStatus, "timeout");
  assert.equal(result.task.status, "running");
  const completed = await manager.output("session-one", task.id, true, 2_000);
  assert.equal(completed.task.status, "completed");
});

test("aborting a TaskOutput wait leaves the background command running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const task = await manager.start("session-one", {
    command: "sleep 0.15; printf survived", timeoutMs: 2_000, runInBackground: true,
  }, [directory]);
  const controller = new AbortController();
  const waiting = manager.output("session-one", task.id, true, 2_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(manager.get("session-one", task.id)?.status, "running");
  const completed = await manager.output("session-one", task.id, true, 2_000);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.stdout, "survived");
});

test("background Bash applies its timeout without blocking TaskOutput", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const task = await manager.start("session-one", {
    command: "sleep 5", timeoutMs: 100, runInBackground: true,
  }, [directory]);
  const completed = await manager.output("session-one", task.id, true, 2_000);
  assert.equal(completed.retrievalStatus, "success");
  assert.equal(completed.task.status, "timed_out");
});

test("TaskStop kills a task and task IDs cannot cross sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const task = await manager.start("session-one", {
    command: "sleep 5", timeoutMs: 10_000, runInBackground: true,
  }, [directory]);

  assert.equal(manager.get("session-two", task.id), null);
  await assert.rejects(manager.output("session-two", task.id, false, 0), /No task found/);
  const stopped = executeTaskStop(manager, "session-one", task.id);
  assert.match(stopped.resultText, /Successfully stopped task/);
  assert.equal(manager.get("session-one", task.id)?.status, "killed");
  await assert.rejects(async () => executeTaskStop(manager, "session-one", task.id), /not running/);
});

test("task listing includes only active tasks for the session, newest first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-task-"));
  const manager = new BackgroundTaskManager();
  const first = await manager.start("session-one", {
    command: "sleep 5", description: "First task", timeoutMs: 10_000, runInBackground: true,
  }, [directory]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await manager.start("session-one", {
    command: "sleep 5", description: "Second task", timeoutMs: 10_000, runInBackground: true,
  }, [directory]);
  const completed = await manager.start("session-one", {
    command: "printf done", timeoutMs: 2_000, runInBackground: true,
  }, [directory]);
  await manager.output("session-one", completed.id, true, 2_000);
  const otherSession = await manager.start("session-two", {
    command: "sleep 5", timeoutMs: 10_000, runInBackground: true,
  }, [directory]);

  assert.deepEqual(manager.list("session-one").map((task) => task.id), [second.id, first.id]);
  assert.equal(manager.list("session-one").some((task) => task.id === completed.id), false);
  assert.equal(manager.list("session-one").some((task) => task.id === otherSession.id), false);
  manager.stopAll();
});

test("task tool parsers use Claude Code argument conventions", () => {
  assert.deepEqual(parseTaskOutputInput({ task_id: "b123", block: false, timeout: 500 }), {
    taskId: "b123", block: false, timeoutMs: 500,
  });
  assert.deepEqual(parseTaskOutputInput({ task_id: "b123" }), {
    taskId: "b123", block: true, timeoutMs: 30_000,
  });
  assert.equal(parseTaskStopInput({ task_id: "b123" }), "b123");
  assert.equal(parseTaskStopInput({ shell_id: "legacy" }), "legacy");
  assert.throws(() => parseTaskOutputInput({ task_id: "b123", timeout: -1 }), /timeout/);
  assert.throws(() => parseTaskStopInput({}), /task_id/);
});
