import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BashInput } from "./bash-tool.js";
import { resolveBashWorkingDirectory } from "./bash-tool.js";

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_TASK_STREAM_CHARACTERS = 200_000;

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
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

interface ManagedTask extends BackgroundTask {
  child: ChildProcess;
  timeoutHandle: NodeJS.Timeout;
  forceKillHandle?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

export interface TaskRetrieval {
  retrievalStatus: "success" | "timeout" | "not_ready";
  task: BackgroundTask;
}

export class BackgroundTaskManager {
  readonly #tasks = new Map<string, ManagedTask>();

  async start(sessionId: string, input: BashInput, allowedDirectories: string[]): Promise<BackgroundTask> {
    const workingDirectory = await resolveBashWorkingDirectory(input.workingDirectory, allowedDirectories);
    const id = generateTaskId();
    const startedAt = new Date();
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
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
    };
    this.#tasks.set(id, task);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      task.stdout = appendTaskOutput(task.stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      task.stderr = appendTaskOutput(task.stderr, chunk.toString());
    });
    child.once("error", (error) => {
      task.stderr = appendTaskOutput(task.stderr, error.message);
      if (task.status === "running") task.status = "failed";
      this.#finish(task, null, startedAt);
    });
    child.once("close", (exitCode) => {
      if (task.status === "running") task.status = exitCode === 0 ? "completed" : "failed";
      this.#finish(task, exitCode, startedAt);
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

  stopSession(sessionId: string): void {
    for (const task of this.#tasks.values()) {
      if (task.sessionId === sessionId && task.status === "running") {
        task.status = "killed";
        this.#terminate(task);
      }
    }
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
    if (!task || task.sessionId !== sessionId) throw new Error(`No task found with ID: ${taskId}`);
    return task;
  }

  #terminate(task: ManagedTask): void {
    killChild(task.child, "SIGTERM");
    task.forceKillHandle ??= setTimeout(() => killChild(task.child, "SIGKILL"), 1_000);
  }

  #finish(task: ManagedTask, exitCode: number | null, startedAt: Date): void {
    if (task.completedAt) return;
    clearTimeout(task.timeoutHandle);
    if (task.forceKillHandle) clearTimeout(task.forceKillHandle);
    task.exitCode = exitCode;
    task.completedAt = new Date().toISOString();
    task.durationMs = Date.now() - startedAt.getTime();
    task.resolveCompletion();
  }
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
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
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
