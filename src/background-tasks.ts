import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BashInput } from "./bash-tool.js";
import { BashOutputBuffer, bashChildEnvironment, resolveBashWorkingDirectory } from "./bash-tool.js";
import { taskNotFoundError } from "./task-errors.js";

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_TASK_STREAM_CHARACTERS = 20_000;

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "timed_out" | "killed";

export interface BackgroundTask {
  id: string;
  type: "local_bash";
  sessionId: string;
  command: string;
  description: string;
  workingDirectory: string;
  status: BackgroundTaskStatus;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  spillPath?: string;
}

interface ManagedTask extends BackgroundTask {
  child: ChildProcess;
  timeoutHandle: NodeJS.Timeout;
  forceKillHandle?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
  combinedBuffer: BashOutputBuffer;
}

export interface TaskRetrieval {
  retrievalStatus: "success" | "timeout" | "not_ready";
  task: BackgroundTask;
}

export class BackgroundTaskManager {
  readonly #tasks = new Map<string, ManagedTask>();

  async start(
    sessionId: string,
    input: BashInput,
    allowedDirectories: string[],
    signal?: AbortSignal,
  ): Promise<BackgroundTask> {
    if (signal?.aborted) throw abortError();
    const workingDirectory = await resolveBashWorkingDirectory(input.workingDirectory, allowedDirectories);
    if (signal?.aborted) throw abortError();
    const id = generateTaskId();
    const startedAt = new Date();
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: workingDirectory,
      env: bashChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const combinedBuffer = new BashOutputBuffer({ name: "task" });
    const task: ManagedTask = {
      id,
      type: "local_bash",
      sessionId,
      command: input.command,
      description: input.description ?? input.command,
      workingDirectory,
      status: "running",
      stdout: "",
      stderr: "",
      combinedOutput: "",
      exitCode: null,
      startedAt: startedAt.toISOString(),
      child,
      timeoutHandle: setTimeout(() => {
        if (task.status !== "running") return;
        task.status = "timed_out";
        this.#terminate(task);
      }, input.timeoutMs),
      completion,
      resolveCompletion,
      combinedBuffer,
    };
    this.#tasks.set(id, task);

    const appendCombined = (text: string) => {
      task.combinedBuffer.append(text);
      task.combinedOutput = task.combinedBuffer.output;
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      task.stdout = appendTaskOutput(task.stdout, text);
      appendCombined(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      task.stderr = appendTaskOutput(task.stderr, text);
      appendCombined(text);
    });
    child.once("error", (error) => {
      task.stderr = appendTaskOutput(task.stderr, error.message);
      appendCombined(error.message);
      if (task.status === "running") task.status = "failed";
      void this.#finish(task, null, startedAt);
    });
    child.once("close", (exitCode) => {
      if (task.status === "running") task.status = exitCode === 0 ? "completed" : "failed";
      void this.#finish(task, exitCode, startedAt);
    });
    return publicTask(task);
  }

  get(sessionId: string, taskId: string): BackgroundTask | null {
    const task = this.#tasks.get(taskId);
    return task?.sessionId === sessionId ? publicTask(task) : null;
  }

  list(sessionId: string): BackgroundTask[] {
    return [...this.#tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.status === "running")
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(publicTask);
  }

  async output(
    sessionId: string,
    taskId: string,
    block: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TaskRetrieval> {
    const task = this.#taskForSession(sessionId, taskId);
    if (task.status !== "running") return { retrievalStatus: "success", task: publicTask(task) };
    if (!block) return { retrievalStatus: "not_ready", task: publicTask(task) };

    const completed = await waitForCompletion(task.completion, timeoutMs, signal);
    return {
      retrievalStatus: completed ? "success" : "timeout",
      task: publicTask(task),
    };
  }

  stop(sessionId: string, taskId: string): BackgroundTask {
    const task = this.#taskForSession(sessionId, taskId);
    if (task.status !== "running") {
      throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
    }
    task.status = "killed";
    this.#terminate(task);
    return publicTask(task);
  }

  stopSession(sessionId: string): BackgroundTask[] {
    const stopped: BackgroundTask[] = [];
    for (const task of this.#tasks.values()) {
      if (task.sessionId === sessionId && task.status === "running") {
        task.status = "killed";
        this.#terminate(task);
        stopped.push(publicTask(task));
      }
    }
    return stopped;
  }

  stopAll(): void {
    for (const task of this.#tasks.values()) {
      if (task.status === "running") {
        task.status = "killed";
        this.#terminate(task);
      }
    }
  }

  #taskForSession(sessionId: string, taskId: string): ManagedTask {
    const task = this.#tasks.get(taskId);
    if (!task || task.sessionId !== sessionId) throw taskNotFoundError(taskId);
    return task;
  }

  #terminate(task: ManagedTask): void {
    killChild(task.child, "SIGTERM");
    task.forceKillHandle ??= setTimeout(() => killChild(task.child, "SIGKILL"), 1_000);
  }

  async #finish(task: ManagedTask, exitCode: number | null, startedAt: Date): Promise<void> {
    if (task.completedAt) return;
    // Mark finished and assign metadata synchronously so a concurrent observer never
    // sees a finished task with missing exit code or spill path.
    task.completedAt = new Date().toISOString();
    task.exitCode = exitCode;
    task.durationMs = Date.now() - startedAt.getTime();
    if (task.combinedBuffer.truncated && !task.combinedBuffer.hasSpillError) {
      const spillPath = task.combinedBuffer.spillPath;
      if (spillPath) task.spillPath = spillPath;
    }
    clearTimeout(task.timeoutHandle);
    if (task.forceKillHandle) clearTimeout(task.forceKillHandle);
    await task.combinedBuffer.finalize();
    task.resolveCompletion();
  }
}

function abortError(): Error {
  const error = new Error("Background Bash aborted");
  error.name = "AbortError";
  return error;
}

function appendTaskOutput(current: string, chunk: string): string {
  if (current.length >= MAX_TASK_STREAM_CHARACTERS) return current;
  const available = MAX_TASK_STREAM_CHARACTERS - current.length;
  if (chunk.length <= available) return current + chunk;
  return `${current}${chunk.slice(0, available)}\n[output truncated]\n`;
}

function publicTask(task: ManagedTask): BackgroundTask {
  return {
    id: task.id,
    type: task.type,
    sessionId: task.sessionId,
    command: task.command,
    description: task.description,
    workingDirectory: task.workingDirectory,
    status: task.status,
    stdout: task.stdout,
    stderr: task.stderr,
    combinedOutput: task.combinedOutput,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
    ...(task.spillPath ? { spillPath: task.spillPath } : {}),
  };
}

function generateTaskId(): string {
  const bytes = randomBytes(8);
  let id = "b";
  for (let index = 0; index < bytes.length; index += 1) {
    id += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return id;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); } catch { /* process already exited */ }
  } else {
    child.kill(signal);
  }
}

function waitForCompletion(completion: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new Error("TaskOutput aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    void completion.then(() => finish(true));
  });
}
