import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition, ToolStatus, ToolStatusDisplay } from "./types.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARACTERS = 200_000;

export const SHELL_TOOL: ToolDefinition = {
  name: "Shell",
  description: "Run a shell command and wait for it to finish. Only one Shell call executes at a time within this session; other sessions may run concurrently. By default the command starts in the session CWD; use working_directory to select another authorized directory for this call.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      working_directory: { type: "string", description: "Absolute path or a path relative to the session CWD. This changes only this Shell call." },
      timeout_ms: {
        type: "integer",
        minimum: 100,
        maximum: MAX_SHELL_TIMEOUT_MS,
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_SHELL_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export interface ShellInput {
  command: string;
  workingDirectory?: string;
  timeoutMs: number;
}

export interface ShellResult {
  output: string;
  resultText: string;
  status: Extract<ToolStatus, "complete" | "error" | "timed_out">;
  exitCode: number | null;
  durationMs: number;
  workingDirectory: string;
  statusDisplay: ToolStatusDisplay;
}

export interface ShellHooks {
  onRunning: (workingDirectory: string, statusDisplay: ToolStatusDisplay) => void;
  onOutput: (chunk: string) => void;
}

export class ShellExecutor {
  #tail: Promise<void> = Promise.resolve();

  run(
    input: ShellInput,
    allowedDirectories: string[],
    signal: AbortSignal,
    hooks: ShellHooks,
  ): Promise<ShellResult> {
    const operation = this.#tail.then(async () => {
      if (signal.aborted) throw abortError();
      const workingDirectory = await resolveWorkingDirectory(input.workingDirectory, allowedDirectories);
      hooks.onRunning(workingDirectory, { text: "RUNNING", appendElapsed: true });
      return executeShell(input, workingDirectory, signal, hooks.onOutput);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function parseShellInput(input: Record<string, unknown>): ShellInput {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Shell requires a non-empty command");
  if (command.length > 32_000) throw new Error("Shell command must be 32,000 characters or fewer");

  const timeout = input.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > MAX_SHELL_TIMEOUT_MS) {
    throw new Error(`Shell timeout_ms must be an integer from 100 to ${MAX_SHELL_TIMEOUT_MS}`);
  }
  if (input.working_directory !== undefined && typeof input.working_directory !== "string") {
    throw new Error("Shell working_directory must be a string");
  }

  return {
    command,
    timeoutMs: timeout as number,
    ...(typeof input.working_directory === "string" && input.working_directory.trim()
      ? { workingDirectory: input.working_directory.trim() }
      : {}),
  };
}

async function resolveWorkingDirectory(requested: string | undefined, allowedDirectories: string[]): Promise<string> {
  const defaultDirectory = allowedDirectories[0];
  if (!defaultDirectory) throw new Error("No Shell working directory is configured");
  const candidate = await realpath(requested
    ? (isAbsolute(requested) ? requested : resolve(defaultDirectory, requested))
    : defaultDirectory);
  const allowed = allowedDirectories.some((directory) => {
    const child = relative(directory, candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new Error(`Working directory is outside the project and added directories: ${candidate}`);
  return candidate;
}

function executeShell(
  input: ShellInput,
  workingDirectory: string,
  signal: AbortSignal,
  onOutput: (chunk: string) => void,
): Promise<ShellResult> {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let visibleOutput = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (visibleOutput.length >= MAX_OUTPUT_CHARACTERS) return;
      const available = MAX_OUTPUT_CHARACTERS - visibleOutput.length;
      const visible = text.slice(0, available);
      visibleOutput += visible;
      onOutput(visible);
      if (text.length > available) {
        const notice = "\n[output truncated]\n";
        visibleOutput += notice;
        onOutput(notice);
      }
    };

    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    const kill = (signalName: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signalName); } catch { /* process already exited */ }
      } else {
        child.kill(signalName);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const abort = () => stop();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(abortError());
      const durationMs = Date.now() - started;
      const status = timedOut ? "timed_out" : exitCode === 0 ? "complete" : "error";
      const sections = [
        `Shell starting directory for this call: ${workingDirectory}`,
        timedOut ? `Timed out after ${input.timeoutMs} ms` : `Exit code: ${exitCode ?? `signal ${closeSignal ?? "unknown"}`}`,
        ...(stdout ? [`stdout:\n${truncate(stdout)}`] : []),
        ...(stderr ? [`stderr:\n${truncate(stderr)}`] : []),
      ];
      resolveResult({
        output: visibleOutput || "(no output)",
        resultText: sections.join("\n\n"),
        status,
        exitCode,
        durationMs,
        workingDirectory,
        statusDisplay: shellFinishedStatus(status, durationMs, input.timeoutMs),
      });
    });
  });
}

function shellFinishedStatus(status: ShellResult["status"], durationMs: number, timeoutMs: number): ToolStatusDisplay {
  if (status === "complete") return { text: formatShellDuration(durationMs) };
  if (status === "timed_out") return { text: `TIMED OUT ${formatShellDuration(timeoutMs)}` };
  return { text: "FAILED" };
}

function formatShellDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT_CHARACTERS ? value : `${value.slice(0, MAX_OUTPUT_CHARACTERS)}\n[output truncated]`;
}

function abortError(): Error {
  const error = new Error("Shell execution aborted");
  error.name = "AbortError";
  return error;
}
