import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  expandBracePattern,
  isPermissionOnlyRipgrepStderr,
  isRipgrepAvailable,
  runSearchProcess,
  VCS_DIRECTORIES_TO_EXCLUDE,
} from "./grep-tool.js";
import type { ToolDefinition } from "./types.js";

const MAX_PATTERN_CHARACTERS = 10_000;
// Cap on returned files; matches the Claude Code Glob tool so the model narrows
// the pattern instead of flooding the context on broad matches.
const GLOB_FILE_LIMIT = 100;

export const GLOB_TOOL: ToolDefinition = {
  name: "Glob",
  description: [
    "- Fast file pattern matching tool that works with any codebase size",
    '- The pattern is matched against file paths relative to path, or relative to the session working directory when path is omitted',
    '- `*` and `?` stay within one directory component; only `**` can match across directory separators',
    '- Supports patterns like "*.js", "**/*.js", "src/*", or "src/**/*.ts"',
    "- Searches hidden and ignored files, but excludes version-control metadata directories",
    "- Returns matching file paths sorted by modification time",
    "- Returned paths are relative to the session working directory when possible, even when path is absolute",
    `- Returns at most ${GLOB_FILE_LIMIT} files. If results are truncated, use a more specific path or pattern`,
    "- Use this tool when you need to find files by name patterns",
    "- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob matched against file paths relative to the search root. * does not cross directories; ** does." },
      path: {
        type: "string",
        description: "Directory that establishes the search root. Defaults to the session working directory. Directory components in pattern are resolved beneath this root.",
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

export type GlobBackend = "rg" | "grep";

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
  backend?: GlobBackend,
): Promise<GlobResult> {
  if (signal?.aborted) throw abortError();
  if (!currentDirectory) throw new Error("No current working directory is configured");
  const searchPath = await resolveSearchPath(input.path, allowedDirectories, currentDirectory);
  if (signal?.aborted) throw abortError();
  const command: GlobBackend = backend ?? ((await isRipgrepAvailable()) ? "rg" : "grep");
  const args: string[] = [];
  if (command === "rg") {
    // The grep fallback does not interpret ignore files. --no-ignore keeps the
    // candidate set consistent before both backends apply the shared matcher.
    args.push("--files", "--hidden", "--no-ignore");
    for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push("--glob", `!${directory}`);
    }
    args.push("--", searchPath);
  } else {
    // grep has no --files mode. -L with an impossible expression lists every file,
    // including empty files; path-relative filtering is applied below for both backends.
    args.push("-r", "-L", "-e", "a^");
    for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push("--exclude-dir", directory);
    }
    args.push("--", searchPath);
  }
  const run = await runSearchProcess(command, args, searchPath, signal ?? new AbortController().signal);
  // rg exits 0 with files, 1 with no matches, and 2+ on error. Permission
  // failures on individual directories should not hide readable matches.
  if (run.exitCode !== null && run.exitCode >= 2 && !isPermissionOnlyRipgrepStderr(run.stderr)) {
    throw new Error(`${command} failed (exit ${run.exitCode}): ${run.stderr.trim() || "unknown error"}`);
  }
  if (run.exitCode === null) throw new Error(`${command} terminated unexpectedly`);
  const matches = globPathMatcher(input.pattern);
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((filePath) => matches(relativeGlobPath(searchPath, filePath)));

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
    + (truncated
      ? `\n(Results truncated after ${GLOB_FILE_LIMIT} files. Use a more specific path or pattern to narrow the search.)`
      : "");
  return { output: resultText, resultText, workingDirectory: searchPath };
}

function relativeGlobPath(searchPath: string, filePath: string): string {
  return relative(searchPath, filePath).replaceAll("\\", "/");
}

/** Compiles Amber's path-relative glob contract independently of the search backend. */
export function globPathMatcher(pattern: string): (filePath: string) => boolean {
  const negated = pattern.startsWith("!");
  const source = negated ? pattern.slice(1) : pattern;
  const alternatives = expandBracePattern(source).map((part) => compileGlobPattern(part));
  return (filePath) => negated !== alternatives.some((tokens) => matchGlobTokens(tokens, filePath));
}

type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "star" | "globstar" | "globstar_directories" | "question" }
  | { kind: "class"; expression: RegExp };

function compileGlobPattern(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      let end = index;
      while (pattern[end + 1] === "*") end += 1;
      if (end > index) {
        if (pattern[end + 1] === "/") {
          tokens.push({ kind: "globstar_directories" });
          end += 1;
        } else {
          tokens.push({ kind: "globstar" });
        }
      } else {
        tokens.push({ kind: "star" });
      }
      index = end;
      continue;
    }
    if (character === "?") {
      tokens.push({ kind: "question" });
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        const body = pattern.slice(index + 1, end);
        const negatedClass = body.startsWith("!");
        const classBody = negatedClass ? body.slice(1) : body;
        try {
          tokens.push({
            kind: "class",
            expression: new RegExp(`^[${negatedClass ? "^" : ""}${classBody.replaceAll("\\", "\\\\")}]$`),
          });
          index = end;
          continue;
        } catch {
          // Treat a malformed character class as literal text, matching common
          // shell glob behavior rather than leaking a JavaScript regex error.
        }
      }
    }
    tokens.push({ kind: "literal", value: character });
  }
  return tokens;
}

function matchGlobTokens(tokens: GlobToken[], filePath: string): boolean {
  let reachable = new Uint8Array(filePath.length + 1);
  reachable[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(filePath.length + 1);
    if (token.kind === "star" || token.kind === "globstar") {
      let active = false;
      for (let position = 0; position <= filePath.length; position += 1) {
        active ||= reachable[position] === 1;
        if (active) next[position] = 1;
        if (token.kind === "star" && filePath[position] === "/") active = false;
      }
    } else if (token.kind === "globstar_directories") {
      next.set(reachable);
      let active = false;
      for (let position = 0; position < filePath.length; position += 1) {
        active ||= reachable[position] === 1;
        if (active && filePath[position] === "/") next[position + 1] = 1;
      }
    } else {
      for (let position = 0; position < filePath.length; position += 1) {
        if (reachable[position] !== 1) continue;
        const character = filePath[position]!;
        if (token.kind === "literal" && character === token.value) next[position + 1] = 1;
        else if (token.kind === "question" && character !== "/") next[position + 1] = 1;
        else if (token.kind === "class" && character !== "/" && token.expression.test(character)) {
          next[position + 1] = 1;
        }
      }
    }
    reachable = next;
  }
  return reachable[filePath.length] === 1;
}
