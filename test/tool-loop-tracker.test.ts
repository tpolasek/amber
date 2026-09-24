import test from "node:test";
import assert from "node:assert/strict";
import { ToolLoopTracker, formatToolLoopError, formatToolLoopNudge } from "../src/tool-loop-tracker.js";

function call(name: string, input: Record<string, unknown>, output = "unchanged") {
  return { name, input, status: "complete", output };
}

test("detects three identical no-progress tool rounds", () => {
  let now = 0;
  const tracker = new ToolLoopTracker(() => now);
  assert.equal(tracker.record([call("Read", { file_path: "a.ts", offset: 1 })]), null);
  now += 1_000;
  assert.equal(tracker.record([call("Read", { offset: 1, file_path: "a.ts" })]), null);
  now += 1_000;
  const detection = tracker.record([call("Read", { file_path: "a.ts", offset: 1 })]);
  assert.deepEqual(detection, { repetitions: 3, cycleLength: 1, toolNames: ["Read"] });
  assert.match(formatToolLoopError(detection!), /same tool call 3 times without progress \(Read\)/);
});

test("detects a short alternating tool cycle", () => {
  const tracker = new ToolLoopTracker();
  const read = [call("Read", { file_path: "a.ts" })];
  const bash = [call("Bash", { command: "git status" }, "clean")];
  for (const round of [read, bash, read, bash, read]) assert.equal(tracker.record(round), null);
  assert.deepEqual(tracker.record(bash), {
    repetitions: 3,
    cycleLength: 2,
    toolNames: ["Read", "Bash"],
  });
});

test("allows unlimited productive tool rounds", () => {
  const tracker = new ToolLoopTracker();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(tracker.record([call("Read", { file_path: "a.ts" }, `output ${index}`)]), null);
  }
});

test("allows repeated blocking calls outside the rapid-loop window", () => {
  let now = 0;
  const tracker = new ToolLoopTracker(() => now);
  const taskOutput = [call("TaskOutput", { task_id: "b123", block: true }, "status: running")];
  for (let index = 0; index < 10; index += 1) {
    assert.equal(tracker.record(taskOutput), null);
    now += 31_000;
  }
});

test("exempts blocking waits on still-running tasks from loop detection", () => {
  let now = 0;
  const tracker = new ToolLoopTracker(() => now);
  const waiting = [{ ...call("TaskOutput", { task_id: "b90bcho0h", block: true, timeout: 5 }, "status: running"), waiting: true }];
  // Rapid identical polls while blocked on a live task never trip, however fast.
  for (let index = 0; index < 10; index += 1) {
    assert.equal(tracker.record(waiting), null);
    now += 1_000;
  }
  // Once the task finishes the same call stops being a wait and counts again.
  const finished = [call("TaskOutput", { task_id: "b90bcho0h", block: true, timeout: 5 }, "status: timed_out")];
  assert.equal(tracker.record(finished), null);
  assert.equal(tracker.record(finished), null);
  assert.deepEqual(tracker.record(finished), { repetitions: 3, cycleLength: 1, toolNames: ["TaskOutput"] });
});

test("still detects loops in rounds that mix waits with real calls", () => {
  const tracker = new ToolLoopTracker();
  const mixed = [
    { ...call("TaskOutput", { task_id: "b1", block: true }, "status: running"), waiting: true },
    call("Read", { file_path: "a.ts" }),
  ];
  for (let index = 0; index < 2; index += 1) assert.equal(tracker.record(mixed), null);
  const detection = tracker.record(mixed);
  assert.deepEqual(detection, { repetitions: 3, cycleLength: 1, toolNames: ["TaskOutput", "Read"] });
});

test("the nudge tells the model to change approach and warns of the stop", () => {
  let now = 0;
  const tracker = new ToolLoopTracker(() => now);
  const round = [call("TaskOutput", { task_id: "b1" }, "status: timed_out")];
  tracker.record(round);
  tracker.record(round);
  const detection = tracker.record(round);
  assert.match(formatToolLoopNudge(detection!), /identical results \(TaskOutput\)/);
  assert.match(formatToolLoopNudge(detection!), /run will be stopped/);
});
