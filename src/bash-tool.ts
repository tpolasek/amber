import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolDefinition, ToolStatus, ToolStatusDisplay } from "./types.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
export const MAX_FOREGROUND_BASH_TIMEOUT_MS = 290_000;
export const MAX_OUTPUT_CHARACTERS = 20_000;
const TRUNCATION_MARKER = "[output truncated]";

export const BASH_TOOL: ToolDefinition = {
  name: "Bash",
  description: `Executes a given bash command and returns its output.

Each call starts in the session current working directory unless working_directory selects another authorized directory for that call. Shell state does not persist between calls. The shell environment is initialized from the user's profile.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, or \`awk\` commands unless explicitly instructed or a dedicated tool cannot accomplish the task. Instead use:

- File search: Glob
- Content search: Grep
- Read files: Read
- Edit files: Edit
- Write files: Write
- Communication: output text directly

# Instructions
- Always quote file paths that contain spaces.
- Prefer absolute paths or working_directory over changing directories inside the command.
- Commands run in the foreground by default and time out after 120000 ms. Foreground calls wait for completion and return the command output directly in Bash's normal result format. Foreground timeout may be at most ${MAX_FOREGROUND_BASH_TIMEOUT_MS} ms; background timeout may be at most ${MAX_BASH_TIMEOUT_MS} ms.
- Set run_in_background when the result is not needed immediately. A background Bash call returns a b-prefixed task ID instead of the command's final output. Pass that ID to TaskOutput to retrieve the output together with task status and exit-code metadata, or to TaskStop to terminate it. Do not append \`&\` when using run_in_background.
- Foreground Bash and background TaskOutput preserve stdout and stderr in the order Amber receives them.
- Output is capped at ${MAX_OUTPUT_CHARACTERS} characters. When it is truncated, the remaining output is written to a temp file whose path is reported at the end of the result so you can read it with the Read tool.
- You may issue separate Bash calls for independent commands, but foreground calls execute one at a time. Chain dependent commands with \`&&\`; use \`;\` only when later commands should run after a failure.
- Avoid unnecessary sleeps and retry loops. Diagnose failures, and use TaskOutput rather than polling background work.
- Foreground Bash calls execute one at a time within this session.`,
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute." },
      working_directory: { type: "string", description: "Absolute path or a path relative to the session CWD. This changes only this Bash call." },
      timeout: {
        type: "integer",
        minimum: 100,
        maximum: MAX_BASH_TIMEOUT_MS,
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_BASH_TIMEOUT_MS}. Foreground calls cap at ${MAX_FOREGROUND_BASH_TIMEOUT_MS}; background calls may go up to ${MAX_BASH_TIMEOUT_MS}.`,
      },
      description: {
        type: "string",
        description: "Clear, concise description of what this command does in active voice.",
      },
      run_in_background: {
        type: "boolean",
        description: "Set to true to return a b-prefixed background Bash task ID instead of waiting for Bash's direct result. Use TaskOutput with that ID to retrieve the command output, task status, and exit-code metadata; TaskStop accepts the same ID namespace.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export interface BashInput {
  command: string;
  workingDirectory?: string;
  timeoutMs: number;
  description?: string;
  runInBackground?: boolean;
}

export interface BashResult {
  output: string;
  resultText: string;
  status: Extract<ToolStatus, "complete" | "error" | "timed_out">;
  exitCode: number | null;
  durationMs: number;
  workingDirectory: string;
  statusDisplay: ToolStatusDisplay;
  spillPath?: string;
}

export interface BashHooks {
  onRunning: (workingDirectory: string, statusDisplay: ToolStatusDisplay) => unknown;
  onOutput: (chunk: string) => void;
}

export interface AppendedBashOutput {
  appended: string;
}

// The system temp directory hosts spilled Bash output
export function bashSpillDirectory(): string {
  return join(tmpdir(), ".amber");
}

/** Bounded accumulator that spills overflow beyond {@link MAX_OUTPUT_CHARACTERS} to a temp file. */
export class BashOutputBuffer {
  readonly #maxCharacters: number;
  readonly #spillDirectory: string;
  readonly #name: string;
  #output = "";
  #spillPath: string | undefined;
  #stream: WriteStream | undefined;
  #truncated = false;
  #finalized = false;
  #spillError: Error | undefined;

  constructor(options: { maxCharacters?: number; spillDirectory?: string; name?: string } = {}) {
    this.#maxCharacters = options.maxCharacters ?? MAX_OUTPUT_CHARACTERS;
    this.#spillDirectory = options.spillDirectory ?? bashSpillDirectory();
    this.#name = options.name ?? "bash";
  }

  get output(): string {
    return this.#output;
  }

  get spillPath(): string | undefined {
    return this.#spillPath;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get hasSpillError(): boolean {
    return this.#spillError !== undefined;
  }

  append(chunk: string): AppendedBashOutput {
    const remaining = this.#maxCharacters - this.#output.length;
    const allowed = chunk.slice(0, Math.max(0, remaining));
    const overflow = chunk.slice(Math.max(0, remaining));
    if (this.#output.length < this.#maxCharacters) {
      this.#output += allowed;
    }
    if (overflow.length > 0) {
      this.#writeOverflow(overflow);
      if (!this.#truncated) {
        this.#truncated = true;
        this.#output += `\n${TRUNCATION_MARKER}\n`;
        return { appended: `${allowed}\n${TRUNCATION_MARKER}\n` };
      }
      return { appended: "" };
    }
    return { appended: allowed };
  }

  /** Flushes the spill stream once the process has finished. */
  async finalize(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    const stream = this.#stream;
    this.#stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      const onError = () => {
        this.#spillError ??= new Error("Failed to write Bash spill file");
        resolve();
      };
      stream.once("error", onError);
      stream.end(() => {
        stream.off("error", onError);
        resolve();
      });
    });
  }

  #writeOverflow(bytes: string): void {
    if (this.#spillError) return;
    if (!this.#stream) {
      try {
        mkdirSync(this.#spillDirectory, { recursive: true });
        const filePath = join(this.#spillDirectory, `${this.#name}-${randomUUID()}.log`);
        this.#spillPath = filePath;
        this.#stream = createWriteStream(filePath, { flags: "w" });
        this.#stream.on("error", (error) => {
          this.#spillError = error;
        });
      } catch (error) {
        this.#spillError = error as Error;
        return;
      }
    }
    this.#stream.write(bytes, (error) => {
      if (error) this.#spillError = error;
    });
  }
}

export function bashChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // node --watch sets this for its direct child; nested Node processes must not inherit it.
  delete environment.WATCH_REPORT_DEPENDENCIES;
  return environment;
}

export class BashExecutor {
  #tail: Promise<void> = Promise.resolve();

  run(
    input: BashInput,
    allowedDirectories: string[],
    signal: AbortSignal,
    hooks: BashHooks,
  ): Promise<BashResult> {
    const operation = this.#tail.then(async () => {
      if (signal.aborted) throw abortError();
      const workingDirectory = await resolveBashWorkingDirectory(input.workingDirectory, allowedDirectories);
      await hooks.onRunning(workingDirectory, { text: "RUNNING", appendElapsed: true });
      if (signal.aborted) throw abortError();
      return executeBash(input, workingDirectory, signal, hooks.onOutput);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function parseBashInput(input: Record<string, unknown>): BashInput {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Bash requires a non-empty command");
  if (command.length > 32_000) throw new Error("Bash command must be 32,000 characters or fewer");

  const timeout = input.timeout ?? input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS;
  const runInBackground = input.run_in_background === true;
  const maximum = runInBackground ? MAX_BASH_TIMEOUT_MS : MAX_FOREGROUND_BASH_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > maximum) {
    throw new Error(`Bash timeout must be an integer from 100 to ${maximum}`);
  }
  if (input.working_directory !== undefined && typeof input.working_directory !== "string") {
    throw new Error("Bash working_directory must be a string");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new Error("Bash description must be a string");
  }
  if (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean") {
    throw new Error("Bash run_in_background must be a boolean");
  }

  return {
    command,
    timeoutMs: timeout as number,
    runInBackground,
    ...(typeof input.working_directory === "string" && input.working_directory.trim()
      ? { workingDirectory: input.working_directory.trim() }
      : {}),
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
  };
}

export async function resolveBashWorkingDirectory(requested: string | undefined, allowedDirectories: string[]): Promise<string> {
  const defaultDirectory = allowedDirectories[0];
  if (!defaultDirectory) throw new Error("No Bash working directory is configured");
  const candidate = await realpath(requested
    ? (isAbsolute(requested) ? requested : resolve(defaultDirectory, requested))
    : defaultDirectory);
  const canonicalAllowedDirectories = await Promise.all(allowedDirectories.map((directory) => realpath(directory)));
  const allowed = canonicalAllowedDirectories.some((directory) => {
    const child = relative(directory, candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new Error(`Working directory is outside the project and added directories: ${candidate}`);
  return candidate;
}

function executeBash(
  input: BashInput,
  workingDirectory: string,
  signal: AbortSignal,
  onOutput: (chunk: string) => void,
): Promise<BashResult> {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: workingDirectory,
      env: bashChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const buffer = new BashOutputBuffer({ name: "bash" });
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const next = buffer.append(text);
      if (next.appended) onOutput(next.appended);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
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
    if (signal.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);

    child.once("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      await buffer.finalize();
      reject(error);
    });
    child.once("close", async (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      await buffer.finalize();
      if (signal.aborted) return reject(abortError());
      const durationMs = Date.now() - started;
      const status = timedOut ? "timed_out" : exitCode === 0 ? "complete" : "error";
      const combined = buffer.output.replace(/\n+$/, "");
      const headline = timedOut
        ? `Timed out after ${input.timeoutMs} ms`
        : `Exit code ${exitCode ?? `signal ${closeSignal ?? "unknown"}`}`;
      const spillPath = successfulSpillPath(buffer);
      const resultText = status === "complete" ? combined : combined ? `${headline}\n${combined}` : headline;
      resolveResult({
        output: buffer.output || "(no output)",
        resultText: spillPath ? `${resultText}\n${spillNotice(spillPath)}` : resultText,
        status,
        exitCode,
        durationMs,
        workingDirectory,
        statusDisplay: bashFinishedStatus(status, durationMs, input.timeoutMs),
        ...(spillPath ? { spillPath } : {}),
      });
    });
  });
}

function bashFinishedStatus(status: BashResult["status"], durationMs: number, timeoutMs: number): ToolStatusDisplay {
  if (status === "complete") return { text: formatBashDuration(durationMs) };
  if (status === "timed_out") return { text: `TIMED OUT ${formatBashDuration(timeoutMs)}` };
  return { text: "FAILED" };
}

function formatBashDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function spillNotice(spillPath: string): string {
  return `[output truncated: full output spilled to ${spillPath}]`;
}

/** Returns the spill path only when the spill actually succeeded (no write error). */
function successfulSpillPath(buffer: BashOutputBuffer): string | undefined {
  return buffer.truncated && !buffer.hasSpillError ? buffer.spillPath : undefined;
}

function abortError(): Error {
  const error = new Error("Bash execution aborted");
  error.name = "AbortError";
  return error;
}
