import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashExecutor, BASH_TOOL, parseBashInput } from "../src/bash-tool.js";

test("defines the Bash tool and parses its input with the default timeout", () => {
  assert.equal(BASH_TOOL.name, "Bash");
  assert.deepEqual(parseBashInput({ command: "  pwd  " }), {
    command: "pwd", timeoutMs: 120_000, runInBackground: false,
  });
  assert.deepEqual(parseBashInput({
    command: "npm test", timeout: 5_000, description: "Run tests", run_in_background: true,
  }), {
    command: "npm test", timeoutMs: 5_000, description: "Run tests", runInBackground: true,
  });
  assert.throws(() => parseBashInput({ command: "pwd", timeout: 50 }), /timeout/);
  assert.throws(() => parseBashInput({ command: "" }), /non-empty command/);
});

test("runs Bash in an allowed directory and captures output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const canonicalDirectory = await realpath(directory);
  const executor = new BashExecutor();
  let runningDirectory = "";
  let runningStatus = {};
  let streamed = "";
  const result = await executor.run(
    { command: "printf amber", timeoutMs: 2_000 },
    [directory],
    new AbortController().signal,
    {
      onRunning: (cwd, status) => { runningDirectory = cwd; runningStatus = status; },
      onOutput: (chunk) => { streamed += chunk; },
    },
  );
  assert.equal(runningDirectory, canonicalDirectory);
  assert.deepEqual(runningStatus, { text: "RUNNING", appendElapsed: true });
  assert.equal(streamed, "amber");
  assert.equal(result.output, "amber");
  assert.equal(result.status, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.workingDirectory, canonicalDirectory);
  assert.match(result.resultText, new RegExp(`Bash starting directory for this call: ${canonicalDirectory}`));
  assert.match(result.statusDisplay.text, /^(?:\d+ms|\d+(?:\.\d)?s)$/);
});

test("times Bash out and serializes concurrent calls within one executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const executor = new BashExecutor();
  const starts: string[] = [];
  const first = executor.run(
    { command: "sleep 0.15", timeoutMs: 2_000 }, [directory], new AbortController().signal,
    { onRunning: () => starts.push("first"), onOutput: () => undefined },
  );
  const second = executor.run(
    { command: "printf second", timeoutMs: 2_000 }, [directory], new AbortController().signal,
    { onRunning: () => starts.push("second"), onOutput: () => undefined },
  );
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["first", "second"]);

  const timedOut = await executor.run(
    { command: "sleep 2", timeoutMs: 100 }, [directory], new AbortController().signal,
    { onRunning: () => undefined, onOutput: () => undefined },
  );
  assert.equal(timedOut.status, "timed_out");
  assert.deepEqual(timedOut.statusDisplay, { text: "TIMED OUT 100ms" });
  assert.match(timedOut.resultText, /Timed out after 100 ms/);
});

test("separate session executors run concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const firstExecutor = new BashExecutor();
  const secondExecutor = new BashExecutor();
  let firstCompleted = false;
  let secondStartedBeforeFirstCompleted = false;
  const first = firstExecutor.run(
    { command: "sleep 0.2", timeoutMs: 2_000 }, [directory], new AbortController().signal,
    { onRunning: () => undefined, onOutput: () => undefined },
  ).then((result) => {
    firstCompleted = true;
    return result;
  });
  const second = secondExecutor.run(
    { command: "printf parallel", timeoutMs: 2_000 }, [directory], new AbortController().signal,
    {
      onRunning: () => { secondStartedBeforeFirstCompleted = !firstCompleted; },
      onOutput: () => undefined,
    },
  );
  await Promise.all([first, second]);
  assert.equal(secondStartedBeforeFirstCompleted, true);
});

test("aborting a foreground Bash call stops its process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const executor = new BashExecutor();
  const controller = new AbortController();
  const started = Date.now();
  const result = executor.run(
    { command: "sleep 10", timeoutMs: 20_000 }, [directory], controller.signal,
    { onRunning: () => controller.abort(), onOutput: () => undefined },
  );

  await assert.rejects(result, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.ok(Date.now() - started < 2_000);
});

test("rejects a working directory outside the allowed roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const executor = new BashExecutor();
  await assert.rejects(
    executor.run(
      { command: "pwd", workingDirectory: tmpdir(), timeoutMs: 2_000 },
      [directory],
      new AbortController().signal,
      { onRunning: () => undefined, onOutput: () => undefined },
    ),
    /outside the project and added directories/,
  );
});
