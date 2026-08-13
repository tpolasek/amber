import test from "node:test";
import assert from "node:assert/strict";
import { ToolLoopTracker, formatToolLoopError } from "../src/tool-loop-tracker.js";

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
