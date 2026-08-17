import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { runRipgrep, VCS_DIRECTORIES_TO_EXCLUDE } from "./grep-tool.js";
import type { ToolDefinition } from "./types.js";

const MAX_PATTERN_CHARACTERS = 10_000;
// Cap on returned files; matches the Claude Code Glob tool so the model narrows
// the pattern instead of flooding the context on broad matches.
const GLOB_FILE_LIMIT = 100;

export const GLOB_TOOL: ToolDefinition = {
  name: "Glob",
  description: [
    "- Fast file pattern matching tool that works with any codebase size",
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts"',
    "- Returns matching file paths sorted by modification time",
    "- Use this tool when you need to find files by name patterns",
    "- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      path: {
        type: "string",
        description: 'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobResult {
  output: string;
  resultText: string;
  workingDirectory: string;
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Glob ${name} must be a string`);
  return value.trim() ? value : undefined;
}

export function parseGlobInput(input: Record<string, unknown>): GlobInput {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!pattern) throw new Error("Glob requires a non-empty pattern");
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    throw new Error(`Glob pattern must be ${MAX_PATTERN_CHARACTERS.toLocaleString()} characters or fewer`);
  }
  const path = optionalString(input, "path");
  return { pattern, ...(path !== undefined ? { path } : {}) };
}

async function resolveSearchPath(
  requested: string | undefined,
  allowedDirectories: string[],
  currentDirectory: string,
): Promise<string> {
  const expanded = requested === "~" || requested?.startsWith("~/")
    ? joinHome(requested)
    : requested;
  const candidate = !expanded
    ? currentDirectory
    : isAbsolute(expanded) ? expanded : resolve(currentDirectory, expanded);
  const canonical = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Path does not exist: ${requested}`);
    throw error;
  });
  const canonicalAllowed = await Promise.all(
    allowedDirectories.map((directory) => realpath(directory).catch(() => directory)),
  );
  const allowed = canonicalAllowed.some((directory) => {
    const child = relative(directory, canonical);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new Error(`Search path is outside the project and added directories: ${canonical}`);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Glob path is not a directory: ${requested}`);
  return canonical;
}

function joinHome(requested: string): string {
  return requested === "~" ? homedir() : resolve(homedir(), requested.slice(2));
}

function abortError(): Error {
  const error = new Error("Glob execution aborted");
  error.name = "AbortError";
  return error;
}

function toRelativePath(filePath: string, currentDirectory: string): string {
  const rel = relative(currentDirectory, filePath);
  if (rel === "") return ".";
  return rel && !isAbsolute(rel) && !rel.startsWith("..") ? rel : filePath;
}

export async function executeGlob(
  input: GlobInput,
  allowedDirectories: string[],
  currentDirectory: string,
  signal?: AbortSignal,
): Promise<GlobResult> {
  if (signal?.aborted) throw abortError();
  if (!currentDirectory) throw new Error("No current working directory is configured");
  const searchPath = await resolveSearchPath(input.path, allowedDirectories, currentDirectory);
  if (signal?.aborted) throw abortError();
  const args = ["--files", "--hidden"];
  for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${directory}`);
  }
  args.push("--glob", input.pattern, "--", searchPath);
  const run = await runRipgrep(args, searchPath, signal ?? new AbortController().signal);
  // rg exits 0 with files, 1 with no matches, and 2+ on error.
  if (run.exitCode !== null && run.exitCode >= 2) {
    throw new Error(`ripgrep failed (exit ${run.exitCode}): ${run.stderr.trim() || "unknown error"}`);
  }
  if (run.exitCode === null) throw new Error("ripgrep terminated unexpectedly");
  const lines = run.stdout.split("\n").filter((line) => line.length > 0);

  // Sort by modification time (newest first) with a filename tiebreaker.
  const stats = await Promise.allSettled(lines.map((filePath) => stat(filePath)));
  const sorted = lines
    .map((filePath, index) => ({
      filePath,
      mtimeMs: stats[index]?.status === "fulfilled" ? stats[index].value.mtimeMs : 0,
    }))
    .sort((left, right) => (right.mtimeMs - left.mtimeMs) || left.filePath.localeCompare(right.filePath))
    .map((entry) => entry.filePath);
  const truncated = sorted.length > GLOB_FILE_LIMIT;
  const filenames = sorted.slice(0, GLOB_FILE_LIMIT).map((filePath) => toRelativePath(filePath, currentDirectory));
  if (filenames.length === 0) {
    return { output: "No files found", resultText: "No files found", workingDirectory: searchPath };
  }
  const resultText = filenames.join("\n")
    + (truncated ? "\n(Results are truncated. Consider using a more specific path or pattern.)" : "");
  return { output: resultText, resultText, workingDirectory: searchPath };
}
