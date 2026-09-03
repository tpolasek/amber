import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
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
  assert.equal(result.resultText, "amber");
  assert.match(result.statusDisplay.text, /^(?:\d+ms|\d+(?:\.\d)?s)$/);
});

test("formats failing Bash results like Claude Code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const executor = new BashExecutor();
  const hooks = { onRunning: () => undefined, onOutput: () => undefined };

  const bare = await executor.run(
    { command: "exit 7", timeoutMs: 2_000 }, [directory], new AbortController().signal, hooks,
  );
  assert.equal(bare.status, "error");
  assert.equal(bare.resultText, "Exit code 7");

  const withStderr = await executor.run(
    { command: "printf oops 1>&2; exit 9", timeoutMs: 2_000 }, [directory], new AbortController().signal, hooks,
  );
  assert.equal(withStderr.resultText, "Exit code 9\noops");

  const mixed = await executor.run(
    { command: "printf out; printf err 1>&2; exit 3", timeoutMs: 2_000 }, [directory], new AbortController().signal, hooks,
  );
  assert.match(mixed.resultText, /^Exit code 3\n(outerr|errout)$/);
});

test("does not leak Node watch dependency reporting into Bash descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const previous = process.env.WATCH_REPORT_DEPENDENCIES;
  process.env.WATCH_REPORT_DEPENDENCIES = "1";
  try {
    const result = await new BashExecutor().run(
      // The login shell bash -lc starts may not have node on its PATH, so spawn this interpreter.
      {
        command: `${process.execPath} -e 'process.stdout.write(process.env.WATCH_REPORT_DEPENDENCIES ?? "unset")'`,
        timeoutMs: 2_000,
      },
      [directory],
      new AbortController().signal,
      { onRunning: () => undefined, onOutput: () => undefined },
    );
    assert.equal(result.status, "complete");
    assert.equal(result.output, "unset");
  } finally {
    if (previous === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
    else process.env.WATCH_REPORT_DEPENDENCIES = previous;
  }
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

test("foreground Bash waits for its running status to persist before spawning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-bash-"));
  const marker = join(directory, "foreground-started");
  const executor = new BashExecutor();
  let releaseStatusSave: () => void = () => undefined;
  const statusSaved = new Promise<void>((resolve) => { releaseStatusSave = resolve; });
  let runningHookStarted: () => void = () => undefined;
  const runningHook = new Promise<void>((resolve) => { runningHookStarted = resolve; });

  const result = executor.run(
    { command: "printf started > foreground-started", timeoutMs: 2_000 },
    [directory],
    new AbortController().signal,
    {
      onRunning: async () => {
        runningHookStarted();
        await statusSaved;
      },
      onOutput: () => undefined,
    },
  );

  await runningHook;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(stat(marker), { code: "ENOENT" });
  releaseStatusSave();
  await result;
  assert.equal(await readFile(marker, "utf8"), "started");
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
