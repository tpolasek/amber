import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { bashChildEnvironment } from "./bash-tool.js";
import type { ToolDefinition } from "./types.js";

export const GREP_TIMEOUT_MS = 60_000;
const MAX_GREP_OUTPUT_CHARACTERS = 10_000_000;
const MAX_PATTERN_CHARACTERS = 10_000;

// Version control system directories excluded from searches because they add noise.
export const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

// Matches rg's --max-columns so long lines (minified bundles, embedded assets) are
// elided instead of flooding output.
const MAX_COLUMNS = 500;
const OMITTED_LONG_LINE = "[Omitted long matching line]";
const MAX_EXPANDED_GLOB_PATTERNS = 100;

// Default cap on grep results when head_limit is unspecified. Unbounded content-mode
// greps can exhaust the conversation context. Pass head_limit=0 explicitly for unlimited.
const DEFAULT_HEAD_LIMIT = 250;

export const GREP_TOOL: ToolDefinition = {
  name: "Grep",
  description: [
    "A powerful search tool built on ripgrep",
    "",
    "  Usage:",
    "  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.",
    '  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")',
    '  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")',
    '  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts',
    "  - Use Agent tool for open-ended searches requiring multiple rounds",
    "  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)",
    "  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`",
    "",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression pattern to search for in file contents" },
      path: { type: "string", description: "File or directory to search in (rg PATH). Defaults to current working directory." },
      glob: { type: "string", description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob' },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
      },
      "-B": { type: "integer", minimum: 0, description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.' },
      "-A": { type: "integer", minimum: 0, description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.' },
      "-C": { type: "integer", minimum: 0, description: "Alias for context." },
      context: { type: "integer", minimum: 0, description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.' },
      "-n": { type: "boolean", description: 'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.' },
      "-i": { type: "boolean", description: "Case insensitive search (rg -i)" },
      type: {
        type: "string",
        description: "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
      },
      head_limit: {
        type: "integer",
        minimum: 0,
        description: "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).",
      },
      offset: { type: "integer", minimum: 0, description: "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0." },
      multiline: { type: "boolean", description: "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export interface GrepInput {
  pattern: string;
  outputMode: "content" | "files_with_matches" | "count";
  showLineNumbers: boolean;
  caseInsensitive: boolean;
  multiline: boolean;
  offset: number;
  headLimit?: number;
  path?: string;
  glob?: string;
  type?: string;
  contextBefore?: number;
  contextAfter?: number;
  context?: number;
}

export interface GrepResult {
  output: string;
  resultText: string;
  workingDirectory: string;
}

// Models occasionally quote numbers and booleans ("head_limit":"3", "-i":"true").
// Coerce those string literals like xude's semanticNumber/semanticBoolean before
// validating; anything else is rejected by the type checks below.
function semanticValue(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Grep ${name} must be a string`);
  return value.trim() ? value : undefined;
}

function optionalCount(input: Record<string, unknown>, name: string): number | undefined {
  const value = semanticValue(input[name]);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Grep ${name} must be an integer greater than or equal to 0`);
  }
  return value as number;
}

function optionalBoolean(input: Record<string, unknown>, name: string): boolean | undefined {
  const value = semanticValue(input[name]);
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Grep ${name} must be a boolean`);
  return value;
}

export function parseGrepInput(input: Record<string, unknown>): GrepInput {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!pattern) throw new Error("Grep requires a non-empty pattern");
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    throw new Error(`Grep pattern must be ${MAX_PATTERN_CHARACTERS.toLocaleString()} characters or fewer`);
  }
  const outputMode = input.output_mode ?? "files_with_matches";
  if (outputMode !== "content" && outputMode !== "files_with_matches" && outputMode !== "count") {
    throw new Error('Grep output_mode must be "content", "files_with_matches", or "count"');
  }
  const path = optionalString(input, "path");
  const glob = optionalString(input, "glob");
  const type = optionalString(input, "type");
  const contextBefore = optionalCount(input, "-B");
  const contextAfter = optionalCount(input, "-A");
  // "context" wins when both it and its "-C" alias are provided.
  const context = optionalCount(input, "context") ?? optionalCount(input, "-C");
  const headLimit = optionalCount(input, "head_limit");
  const offset = optionalCount(input, "offset") ?? 0;
  return {
    pattern,
    outputMode,
    showLineNumbers: optionalBoolean(input, "-n") ?? true,
    caseInsensitive: optionalBoolean(input, "-i") ?? false,
    multiline: optionalBoolean(input, "multiline") ?? false,
    offset,
    ...(headLimit !== undefined ? { headLimit } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(glob !== undefined ? { glob } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(contextBefore !== undefined ? { contextBefore } : {}),
    ...(contextAfter !== undefined ? { contextAfter } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

function splitGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const raw of glob.split(/\s+/)) {
    // Preserve brace patterns; split comma-separated lists otherwise.
    if (raw.includes("{") && raw.includes("}")) patterns.push(raw);
    else patterns.push(...raw.split(",").filter(Boolean));
  }
  return patterns.filter(Boolean);
}

function buildRipgrepArgs(input: GrepInput): string[] {
  const args = ["--hidden"];
  for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${directory}`);
  }
  args.push("--max-columns", String(MAX_COLUMNS));
  if (input.multiline) args.push("-U", "--multiline-dotall");
  if (input.caseInsensitive) args.push("-i");
  if (input.outputMode === "files_with_matches") args.push("-l");
  else if (input.outputMode === "count") args.push("-c");
  if (input.outputMode === "content") {
    if (input.showLineNumbers) args.push("-n");
    if (input.context !== undefined) args.push("-C", String(input.context));
    else {
      if (input.contextBefore !== undefined) args.push("-B", String(input.contextBefore));
      if (input.contextAfter !== undefined) args.push("-A", String(input.contextAfter));
    }
  }
  // Always pass the pattern via -e so patterns starting with "-" stay patterns.
  args.push("-e", input.pattern);
  if (input.type) args.push("--type", input.type);
  if (input.glob) for (const pattern of splitGlobPatterns(input.glob)) args.push("--glob", pattern);
  return args;
}

// grep --include/--exclude globs are matched against file basenames only, and neither
// BSD nor GNU grep expands braces, so "{ts,md}" lists and "src/**/*.ts" path scoping
// must be flattened before they can filter a grep invocation. Flattening drops
// directory scoping, so "src/**/*.ts" broadens to every "*.ts" at any depth.
export function expandBracePattern(pattern: string): string[] {
  const match = /^(.*?)\{([^{}]*)\}(.*)$/.exec(pattern);
  if (!match) return [pattern];
  const before = match[1] ?? "";
  const alternatives = match[2] ?? "";
  const after = match[3] ?? "";
  const expanded = alternatives
    .split(",")
    .flatMap((alternative) => expandBracePattern(`${before}${alternative}${after}`));
  // Nested brace groups multiply exponentially; cap them so a hostile pattern cannot
  // block the event loop before the timeout or abort handling can run.
  if (expanded.length > MAX_EXPANDED_GLOB_PATTERNS) {
    throw new Error(`glob pattern expands to more than ${MAX_EXPANDED_GLOB_PATTERNS} alternatives`);
  }
  return expanded;
}

export function basenameGlob(pattern: string): string {
  const segments = pattern.split("/");
  return segments[segments.length - 1] || pattern;
}

// True when the pattern contains an actual newline or a "\\n" escape that rg would
// reject outside multiline mode. Escaped backslashes ("\\\\n") are stripped first so
// they do not masquerade as the escape.
function patternContainsNewlineEscape(pattern: string): boolean {
  return pattern.includes("\n") || pattern.replace(/\\\\/g, "  ").includes("\\n");
}

// rg --type expansions (from `rg --type-list`) for the grep fallback; unknown types
// fall back to "*.<type>", which covers the common extension-named types.
const GREP_TYPE_GLOBS: Record<string, readonly string[]> = {
  c: ["*.c", "*.h"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.c++", "*.h", "*.hpp", "*.hh", "*.hxx", "*.h++"],
  css: ["*.css", "*.scss"],
  go: ["*.go"],
  html: ["*.html", "*.htm"],
  java: ["*.java", "*.jsp", "*.jspx", "*.properties"],
  js: ["*.cjs", "*.js", "*.jsx", "*.mjs", "*.vue"],
  json: ["*.json", "*.sarif", "composer.lock"],
  markdown: ["*.markdown", "*.md", "*.mdown", "*.mdwn", "*.mdx", "*.mkd", "*.mkdn"],
  py: ["*.py", "*.pyi"],
  rust: ["*.rs"],
  ts: ["*.cts", "*.mts", "*.ts", "*.tsx"],
  yaml: ["*.yaml", "*.yml"],
};

const GREP_TYPE_ALIASES: Record<string, string> = {
  golang: "go",
  md: "markdown",
  python: "py",
  rs: "rust",
  yml: "yaml",
};

function grepTypeGlobs(type: string): string[] {
  const canonical = GREP_TYPE_ALIASES[type] ?? type;
  return GREP_TYPE_GLOBS[canonical] ? [...GREP_TYPE_GLOBS[canonical]] : [`*.${canonical}`];
}

// Fallback translation for environments without ripgrep. grep searches hidden files
// by default, so neither --hidden nor VCS --glob exclusions map directly (directories
// use --exclude-dir instead). Directories recurse with -r; single files omit it and
// pass -h so the filename prefix matches ripgrep's single-file output. Multiline
// matching has no equivalent and is rejected before reaching this builder.
export function buildGrepArgs(input: GrepInput, searchPathIsDirectory = true): string[] {
  const args = searchPathIsDirectory ? ["-r"] : ["-h"];
  for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--exclude-dir", directory);
  }
  if (input.caseInsensitive) args.push("-i");
  if (input.outputMode === "files_with_matches") args.push("-l");
  else if (input.outputMode === "count") args.push("-c");
  if (input.outputMode === "content") {
    if (input.showLineNumbers) args.push("-n");
    if (input.context !== undefined) args.push("-C", String(input.context));
    else {
      if (input.contextBefore !== undefined) args.push("-B", String(input.contextBefore));
      if (input.contextAfter !== undefined) args.push("-A", String(input.contextAfter));
    }
  }
  args.push("-e", input.pattern);
  // grep ORs --include globs while rg ANDs type with glob filters, so honoring both
  // would widen results beyond rg's; the explicit glob wins when both are provided.
  if (input.type && !input.glob) {
    for (const glob of grepTypeGlobs(input.type)) args.push("--include", glob);
  }
  if (input.glob) {
    for (const pattern of splitGlobPatterns(input.glob)) {
      const negated = pattern.startsWith("!");
      for (const expanded of expandBracePattern(negated ? pattern.slice(1) : pattern)) {
        args.push(negated ? "--exclude" : "--include", basenameGlob(expanded));
      }
    }
  }
  return args;
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
  return canonical;
}

function joinHome(requested: string): string {
  return requested === "~" ? homedir() : resolve(homedir(), requested.slice(2));
}

export interface SearchProcessRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// ripgrep is preferred but not required; when it is missing the tools fall back to
// the system grep. Probe once per process so every search does not pay detection cost.
let ripgrepAvailability: Promise<boolean> | undefined;

export function isRipgrepAvailable(): Promise<boolean> {
  ripgrepAvailability ??= new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { env: bashChildEnvironment(), stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (exitCode) => resolve(exitCode === 0));
  });
  return ripgrepAvailability;
}

export function runSearchProcess(
  command: "rg" | "grep",
  args: string[],
  searchPath: string,
  signal: AbortSignal,
  maxLineLength?: number,
): Promise<SearchProcessRun> {
  return new Promise((resolveRun, reject) => {
    // The search path may be a single file; processes can only start in directories.
    const child = spawn(command, args, {
      cwd: dirname(searchPath),
      env: bashChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // grep has no --max-columns equivalent, so over-long lines are elided as they
    // stream in; otherwise a single minified line could exhaust the output cap.
    let pendingLine = "";
    const elide = (text: string): string => {
      if (maxLineLength === undefined) return text;
      pendingLine += text;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      const elided = lines.map((line) => (line.length > maxLineLength ? OMITTED_LONG_LINE : line));
      return lines.length > 0 ? `${elided.join("\n")}\n` : "";
    };
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const kill = (signalName: NodeJS.Signals) => {
      child.kill(signalName);
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
    }, GREP_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += elide(chunk.toString());
      if (!outputTooLarge && stdout.length > MAX_GREP_OUTPUT_CHARACTERS) {
        outputTooLarge = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error(`${command} was not found on PATH; install ripgrep (rg) or grep to use the Grep and Glob tools`)
        : error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(abortError());
      if (maxLineLength !== undefined && pendingLine.length > 0) {
        stdout += pendingLine.length > maxLineLength ? OMITTED_LONG_LINE : pendingLine;
        pendingLine = "";
      }
      if (timedOut) return reject(new Error(`${command} timed out after ${GREP_TIMEOUT_MS / 1000}s`));
      if (outputTooLarge) {
        return reject(new Error(
          `${command} output exceeded ${MAX_GREP_OUTPUT_CHARACTERS.toLocaleString()} characters; narrow the pattern or use head_limit and offset`,
        ));
      }
      resolveRun({ exitCode, stdout, stderr });
    });
  });
}

function abortError(): Error {
  const error = new Error("Grep execution aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

// rg exits 2 when it cannot descend into a directory (common under shared temp
// dirs like /tmp because of root-owned systemd-private-* and snap dirs) while
// still writing readable matches to stdout. Treat those as skippable so Grep
// and Glob return partial results plus a warning instead of failing hard.
const PERMISSION_ERROR = /permission denied|operation not permitted|access is denied|os error 13|os error 1\b/i;

export function isPermissionOnlyRipgrepStderr(stderr: string): boolean {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => PERMISSION_ERROR.test(line));
}

function applyHeadLimit<T>(items: T[], limit: number | undefined, offset: number): { items: T[]; appliedLimit?: number } {
  // Explicit 0 = unlimited escape hatch.
  if (limit === 0) return { items: items.slice(offset) };
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  // Only report appliedLimit when truncation actually occurred, so the model
  // knows there may be more results and can paginate with offset.
  const wasTruncated = items.length - offset > effectiveLimit;
  return {
    items: sliced,
    ...(wasTruncated ? { appliedLimit: effectiveLimit } : {}),
  };
}

function formatLimitInfo(appliedLimit: number | undefined, offset: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (offset > 0) parts.push(`offset: ${offset}`);
  return parts.join(", ");
}

function toRelativePath(filePath: string, currentDirectory: string): string {
  const rel = relative(currentDirectory, filePath);
  if (rel === "") return ".";
  return rel && !isAbsolute(rel) && !rel.startsWith("..") ? rel : filePath;
}

// rg prefixes directory-search output with the absolute search path ("/abs/path:12:line";
// context lines use "-" instead of ":"). Single-file searches omit the path entirely.
// Match the known search path exactly instead of scanning for separators, which breaks
// when the search path itself contains dashes.
function relativizeLine(line: string, searchPath: string, currentDirectory: string): string {
  if (line !== searchPath && !line.startsWith(`${searchPath}/`)) return line;
  const relativeRoot = toRelativePath(searchPath, currentDirectory);
  const rest = line.slice(searchPath.length + (line === searchPath ? 0 : 1));
  return relativeRoot === "." ? rest : `${relativeRoot}/${rest}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export async function executeGrep(
  input: GrepInput,
  allowedDirectories: string[],
  currentDirectory: string,
  signal?: AbortSignal,
): Promise<GrepResult> {
  throwIfAborted(signal);
  if (!currentDirectory) throw new Error("No current working directory is configured");
  const searchPath = await resolveSearchPath(input.path, allowedDirectories, currentDirectory);
  throwIfAborted(signal);
  const command: "rg" | "grep" = (await isRipgrepAvailable()) ? "rg" : "grep";
  if (command === "grep") {
    if (input.multiline) throw new Error("multiline search requires ripgrep (rg), which was not found on PATH");
    // rg rejects the "\\n" escape outside multiline mode; reject it here too, since grep
    // would otherwise silently treat the escape as a literal "n" and match nothing.
    // Doubling ("\\\\n") is an escaped backslash plus "n", which rg allows through.
    if (patternContainsNewlineEscape(input.pattern)) {
      throw new Error('the literal "\\n" is not allowed in a regex; enable multiline (requires ripgrep)');
    }
  }
  const args = [
    ...(command === "rg"
      ? buildRipgrepArgs(input)
      : buildGrepArgs(input, (await stat(searchPath)).isDirectory())),
    "--",
    searchPath,
  ];
  // rg elides long lines itself via --max-columns; the grep fallback needs it done here.
  const maxLineLength = command === "grep" && input.outputMode === "content" ? MAX_COLUMNS : undefined;
  const run = await runSearchProcess(command, args, searchPath, signal ?? new AbortController().signal, maxLineLength);
  // rg exits 0 with matches, 1 with no matches, and 2+ on error. Permission
  // failures on individual directories should not hide readable matches.
  const permissionOnly = run.exitCode !== null && run.exitCode >= 2 && isPermissionOnlyRipgrepStderr(run.stderr);
  if (run.exitCode !== null && run.exitCode >= 2 && !permissionOnly) {
    throw new Error(`${command} failed (exit ${run.exitCode}): ${run.stderr.trim() || "unknown error"}`);
  }
  if (run.exitCode === null) throw new Error(`${command} terminated unexpectedly`);
  let lines = run.stdout.split("\n").filter((line) => line.length > 0);
  // grep -c reports "path:0" for files without matches; rg omits them entirely.
  if (input.outputMode === "count") lines = lines.filter((line) => !/(^|:)0$/.test(line));

  const warning = permissionOnly ? "\n\nWarning: some directories could not be read (permission denied); results may be incomplete." : "";

  if (input.outputMode === "content") {
    const { items, appliedLimit } = applyHeadLimit(lines, input.headLimit, input.offset);
    const finalLines = items.map((line) => relativizeLine(line, searchPath, currentDirectory));
    const limitInfo = formatLimitInfo(appliedLimit, input.offset);
    if (finalLines.length === 0) return noMatches(searchPath, warning);
    const content = finalLines.join("\n");
    const resultText = limitInfo ? `${content}\n\n[Showing results with pagination = ${limitInfo}]` : content;
    return { output: resultText + warning, resultText: resultText + warning, workingDirectory: searchPath };
  }

  if (input.outputMode === "count") {
    const { items, appliedLimit } = applyHeadLimit(lines, input.headLimit, input.offset);
    const finalLines = items.map((line) => relativizeLine(line, searchPath, currentDirectory));
    let totalMatches = 0;
    let fileCount = 0;
    for (const line of finalLines) {
      const colonIndex = line.lastIndexOf(":");
      // Single-file searches print a bare count without a "path:" prefix.
      if (colonIndex > 0) {
        const count = Number.parseInt(line.slice(colonIndex + 1), 10);
        if (Number.isInteger(count)) {
          totalMatches += count;
          fileCount += 1;
        }
      } else if (Number.isInteger(Number.parseInt(line, 10))) {
        totalMatches += Number.parseInt(line, 10);
        fileCount += 1;
      }
    }
    const limitInfo = formatLimitInfo(appliedLimit, input.offset);
    if (finalLines.length === 0) return noMatches(searchPath, warning);
    const summary = `\n\nFound ${totalMatches} total ${plural(totalMatches, "occurrence")} across ${fileCount} ${plural(fileCount, "file")}.${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
    const resultText = `${finalLines.join("\n")}${summary}`;
    return { output: resultText + warning, resultText: resultText + warning, workingDirectory: searchPath };
  }

  // files_with_matches: sort by modification time (newest first) with a filename tiebreaker.
  const stats = await Promise.allSettled(lines.map((filePath) => stat(filePath)));
  const sorted = lines
    .map((filePath, index) => ({
      filePath,
      mtimeMs: stats[index]?.status === "fulfilled" ? stats[index].value.mtimeMs : 0,
    }))
    .sort((left, right) => (right.mtimeMs - left.mtimeMs) || left.filePath.localeCompare(right.filePath))
    .map((entry) => entry.filePath);
  const { items, appliedLimit } = applyHeadLimit(sorted, input.headLimit, input.offset);
  const filenames = items.map((filePath) => toRelativePath(filePath, currentDirectory));
  if (filenames.length === 0) {
    return { output: `No files found${warning}`, resultText: `No files found${warning}`, workingDirectory: searchPath };
  }
  const limitInfo = formatLimitInfo(appliedLimit, input.offset);
  const resultText = `Found ${filenames.length} ${plural(filenames.length, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${filenames.join("\n")}`;
  return { output: resultText + warning, resultText: resultText + warning, workingDirectory: searchPath };
}

function noMatches(searchPath: string, warning = ""): GrepResult {
  return { output: `No matches found${warning}`, resultText: `No matches found${warning}`, workingDirectory: searchPath };
}
