import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { FileReadState, Session, ToolDefinition, ToolReadRange } from "./types.js";

const MAX_LINES_TO_READ = 2_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_CHARACTERS = 100_000;
const MAX_EDIT_BYTES = 1024 * 1024 * 1024;
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full", "/dev/stdin", "/dev/tty", "/dev/console",
  "/dev/stdout", "/dev/stderr", "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
]);
const UNSUPPORTED_READ_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ipynb"]);
const STATIC_READ_DIRECTORIES = [join(homedir(), ".amber", "plans")];

export const READ_TOOL: ToolDefinition = {
  name: "Read",
  description: `Read a text file from the local filesystem. Relative file_path values resolve from the session current working directory; absolute and ~/ paths are also accepted. By default this reads up to ${MAX_LINES_TO_READ} lines from line 1. Results use cat -n style line numbers. Use offset and limit for large files. Read files, not directories. Previously returned ranges remain in conversation context; do not reread them. A redundant Read returns only a short cache reminder.`,
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path, absolute or relative to the session current working directory." },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LINES_TO_READ, description: "Maximum lines to read." },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
};

export const WRITE_TOOL: ToolDefinition = {
  name: "Write",
  description: "Write a file to the local filesystem. Relative file_path values resolve from the session current working directory; absolute and ~/ paths are also accepted. Existing files must first be fully read once with Read so their contents are available in conversation context; repeated Reads are unnecessary. Prefer Edit for small changes; Write replaces the complete file. A successful Write invalidates cached Read coverage for this file, so a later inspection may Read it once again.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to create or overwrite, absolute or relative to the session current working directory." },
      content: { type: "string", description: "Complete new file content." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
};

export const EDIT_TOOL: ToolDefinition = {
  name: "Edit",
  description: "Perform an exact string replacement in a text file. Relative file_path values resolve from the session current working directory; absolute and ~/ paths are also accepted. Before editing, Read the file or at least the lines around old_string; an Edit is allowed once every line of old_string was returned by an earlier Read (a full-file Read always qualifies), so do not repeatedly Read it before editing. old_string must be unique unless replace_all is true. Never include Read's line-number prefix in old_string. A successful Edit invalidates cached Read coverage for this file, so a later inspection may Read it once again.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path to modify, absolute or relative to the session current working directory." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text; must differ from old_string." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

export const FILE_TOOLS = [READ_TOOL, WRITE_TOOL, EDIT_TOOL];

export interface FileToolResult {
  filePath: string;
  output: string;
  resultText: string;
  readRange?: ToolReadRange;
}

export interface FileToolPolicy {
  onlyMutationPath?: string;
}

export async function executeFileTool(
  name: string,
  input: Record<string, unknown>,
  allowedDirectories: string[],
  session: Session,
  currentDirectory = allowedDirectories[0],
  signal?: AbortSignal,
  policy?: FileToolPolicy,
): Promise<FileToolResult> {
  throwIfAborted(signal);
  if (!currentDirectory) throw new Error("No current working directory is configured");
  if (name === READ_TOOL.name) return readTextFile(input, allowedDirectories, currentDirectory, session, signal);
  if (name === WRITE_TOOL.name) {
    await assertMutationPolicy(input.file_path, currentDirectory, policy);
    return writeTextFile(input, allowedDirectories, currentDirectory, session);
  }
  if (name === EDIT_TOOL.name) {
    await assertMutationPolicy(input.file_path, currentDirectory, policy);
    return editTextFile(input, allowedDirectories, currentDirectory, session);
  }
  throw new Error(`Unknown file tool: ${name}`);
}

async function assertMutationPolicy(
  value: unknown,
  currentDirectory: string,
  policy?: FileToolPolicy,
): Promise<void> {
  if (!policy?.onlyMutationPath) return;
  const requested = resolve(resolvedFilePath(value, currentDirectory));
  const allowed = resolve(policy.onlyMutationPath);
  if (requested !== allowed) {
    throw new Error(`Plan mode only permits Write or Edit for the active plan file: ${allowed}`);
  }
  const canonicalParent = await canonicalProspectivePath(dirname(allowed));
  const canonicalAllowed = join(canonicalParent, basename(allowed));
  const existingTarget = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return canonicalAllowed;
    throw error;
  });
  if (existingTarget !== canonicalAllowed) {
    throw new Error(`Plan mode cannot modify a plan path that redirects to another file: ${allowed}`);
  }
}

async function canonicalProspectivePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(filePath);
    if (parent === filePath) throw error;
    return join(await canonicalProspectivePath(parent), basename(filePath));
  }
}

async function readTextFile(
  input: Record<string, unknown>,
  allowedDirectories: string[],
  currentDirectory: string,
  session: Session,
  signal?: AbortSignal,
): Promise<FileToolResult> {
  const requestedPath = resolvedFilePath(input.file_path, currentDirectory);
  assertSupportedTextPath(requestedPath);
  if (isBlockedDevice(requestedPath)) throw new Error(`Cannot read '${requestedPath}': this device file would block or produce infinite output.`);
  const filePath = await resolveExistingPath(requestedPath, [...new Set([...allowedDirectories, ...STATIC_READ_DIRECTORIES])]);
  throwIfAborted(signal);
  const metadata = await stat(filePath);
  throwIfAborted(signal);
  if (!metadata.isFile()) throw new Error(`Read only supports files, not directories: ${filePath}`);
  const offset = integer(input.offset, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
  const limit = integer(input.limit, "limit", 1, MAX_LINES_TO_READ, MAX_LINES_TO_READ);
  const prior = session.fileReadState?.[filePath];
  if (readRangeCovered(prior, offset, limit)) {
    const endLine = Math.min(prior?.totalLines ?? offset + limit - 1, offset + limit - 1);
    return {
      filePath,
      output: "Cached Read · reused earlier context",
      resultText: `<system-reminder>Lines ${offset}-${Math.max(offset, endLine)} of ${filePath} were already returned by an earlier Read and remain available in the active conversation context. Reuse that content. Do not call Read again for this range unless Write or Edit changes the file.</system-reminder>`,
      readRange: { startLine: offset, endLine: Math.max(offset, endLine), totalLines: prior?.totalLines ?? endLine },
    };
  }
  if (metadata.size > MAX_READ_BYTES && input.limit === undefined) {
    throw new Error(`File is too large to read (${metadata.size.toLocaleString()} bytes). Use offset and limit to read a specific portion.`);
  }
  const buffer = await readFile(filePath, { signal });
  throwIfAborted(signal);
  if (buffer.includes(0)) throw new Error("Read only supports text files in this version of AMBER");
  const content = buffer.toString("utf8").replaceAll("\r\n", "\n");
  const lines = splitLines(content);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  if (selected.reduce((total, line) => total + line.length + 1, 0) > MAX_READ_CHARACTERS) {
    throw new Error("File content exceeds the 25,000-token read limit. Use a smaller offset and limit range.");
  }
  const full = offset === 1 && selected.length === lines.length;
  updateReadCoverage(session, filePath, buffer, metadata.mtimeMs, lines.length, offset, selected.length, full);

  const numbered = selected.map((line, index) => `${String(offset + index).padStart(6)}→${line}`).join("\n");
  const resultText = numbered || (lines.length === 0
    ? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
    : `<system-reminder>Warning: the file is shorter than offset ${offset}. It has ${lines.length} lines.</system-reminder>`);
  return {
    filePath,
    output: resultText,
    resultText,
    readRange: {
      startLine: selected.length > 0 ? offset : 0,
      endLine: selected.length > 0 ? offset + selected.length - 1 : 0,
      totalLines: lines.length,
    },
  };
}

async function writeTextFile(
  input: Record<string, unknown>,
  allowedDirectories: string[],
  currentDirectory: string,
  session: Session,
): Promise<FileToolResult> {
  const requestedPath = resolvedFilePath(input.file_path, currentDirectory);
  assertSupportedTextPath(requestedPath);
  if (typeof input.content !== "string") throw new Error("Write requires string content");
  const { filePath, existing } = await resolveWritePath(requestedPath, allowedDirectories);
  if (existing) {
    if (!(await stat(filePath)).isFile()) throw new Error(`Write only supports files: ${filePath}`);
    requireFullRead(filePath, session);
  }
  const oldContent = existing ? await readFile(filePath, "utf8") : "";
  await atomicWrite(filePath, input.content);
  await updateWrittenFileState(filePath, session);
  return {
    filePath,
    output: unifiedDiff(filePath, oldContent, input.content, !existing),
    resultText: existing
      ? `The file ${filePath} has been updated successfully.`
      : `File created successfully at: ${filePath}`,
  };
}

async function editTextFile(
  input: Record<string, unknown>,
  allowedDirectories: string[],
  currentDirectory: string,
  session: Session,
): Promise<FileToolResult> {
  const requestedPath = resolvedFilePath(input.file_path, currentDirectory);
  assertSupportedTextPath(requestedPath);
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    throw new Error("Edit requires string old_string and new_string values");
  }
  if (input.old_string === input.new_string) throw new Error("No changes to make: old_string and new_string are exactly the same.");
  if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") throw new Error("Edit replace_all must be a boolean");
  const resolved = await resolveWritePath(requestedPath, allowedDirectories);
  const filePath = resolved.filePath;
  if (!resolved.existing) {
    if (input.old_string !== "") throw new Error(`File does not exist: ${filePath}`);
    await atomicWrite(filePath, input.new_string);
    await updateWrittenFileState(filePath, session);
    return {
      filePath,
      output: unifiedDiff(filePath, "", input.new_string, true),
      resultText: `File created successfully at: ${filePath}`,
    };
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`Edit only supports files: ${filePath}`);
  if (metadata.size > MAX_EDIT_BYTES) throw new Error("File is too large to edit");
  const rawBuffer = await readFile(filePath);
  if (rawBuffer.includes(0)) throw new Error("Edit only supports text files in this version of AMBER");
  const rawOriginal = rawBuffer.toString("utf8");
  const usesCrlf = rawOriginal.includes("\r\n");
  const original = rawOriginal.replaceAll("\r\n", "\n");
  const oldString = input.old_string;
  const replaceAll = input.replace_all === true;
  requireEditReadCoverage(filePath, session, rawBuffer, original, oldString, replaceAll);
  if (oldString === "" && original !== "") throw new Error("Cannot create new file: file already exists and is not empty.");
  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`Found ${occurrences} matches of the string to replace, but replace_all is false. Set replace_all to true or provide more context.`);
  }
  const updated = replaceAll ? original.replaceAll(oldString, input.new_string) : original.replace(oldString, input.new_string);
  await atomicWrite(filePath, usesCrlf ? updated.replaceAll("\n", "\r\n") : updated);
  await updateWrittenFileState(filePath, session);
  return {
    filePath,
    output: unifiedDiff(filePath, original, updated),
    resultText: replaceAll
      ? `The file ${filePath} has been updated. All ${occurrences} occurrences were successfully replaced.`
      : `The file ${filePath} has been updated successfully.`,
  };
}

function requireFullRead(filePath: string, session: Session): void {
  const prior = session.fileReadState?.[filePath];
  if (!prior?.full) throw new Error("File has not been fully read yet. Read it first before writing to it.");
}

function requireEditReadCoverage(
  filePath: string,
  session: Session,
  rawBuffer: Buffer,
  original: string,
  oldString: string,
  replaceAll: boolean,
): void {
  const prior = session.fileReadState?.[filePath];
  if (prior?.full) return;
  if (!prior || prior.hash !== hash(rawBuffer)) {
    throw new Error("File has not been fully read yet. Read it first before writing to it.");
  }
  for (const span of editLineSpans(original, oldString, replaceAll)) {
    if (!rangesCoverLines(prior, span.startLine, span.endLine)) {
      throw new Error(
        `Lines ${span.startLine}-${span.endLine} of ${filePath} have not been read yet. Read that range before editing it.`,
      );
    }
  }
}

function editLineSpans(content: string, needle: string, all: boolean): Array<{ startLine: number; endLine: number }> {
  if (!needle) return [];
  const spans: Array<{ startLine: number; endLine: number }> = [];
  let searchFrom = 0;
  while (true) {
    const index = content.indexOf(needle, searchFrom);
    if (index === -1) break;
    const startLine = content.slice(0, index).split("\n").length;
    spans.push({ startLine, endLine: startLine + needle.split("\n").length - 1 });
    if (!all) break;
    searchFrom = index + needle.length;
  }
  return spans;
}

async function updateWrittenFileState(filePath: string, session: Session): Promise<void> {
  const [buffer, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  const totalLines = splitLines(buffer.toString("utf8").replaceAll("\r\n", "\n")).length;
  (session.fileReadState ??= {})[filePath] = {
    ...readState(buffer, metadata.mtimeMs, true),
    totalLines,
    ranges: [],
    hasRead: false,
  };
}

function readState(buffer: Buffer, mtimeMs: number, full: boolean): FileReadState {
  return { mtimeMs, size: buffer.length, hash: hash(buffer), full };
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function updateReadCoverage(
  session: Session,
  filePath: string,
  buffer: Buffer,
  mtimeMs: number,
  totalLines: number,
  offset: number,
  selectedLines: number,
  full: boolean,
): void {
  const current = readState(buffer, mtimeMs, full);
  const prior = session.fileReadState?.[filePath];
  const sameContent = prior?.hash === current.hash && prior.size === current.size;
  const ranges = sameContent ? [...(prior.ranges ?? [])] : [];
  if (selectedLines > 0) ranges.push({ startLine: offset, endLine: offset + selectedLines - 1 });
  const mergedRanges = mergeReadRanges(ranges);
  const fullyCovered = totalLines === 0 || (mergedRanges.length === 1
    && mergedRanges[0]?.startLine === 1 && mergedRanges[0].endLine >= totalLines);
  (session.fileReadState ??= {})[filePath] = {
    ...current,
    full: full || fullyCovered || (sameContent && prior?.full === true),
    totalLines,
    ranges: mergedRanges,
    hasRead: true,
  };
}

function readRangeCovered(state: FileReadState | undefined, offset: number, limit: number): boolean {
  if (state?.totalLines === undefined || !state.hasRead) return false;
  if (offset > state.totalLines) return true;
  return rangesCoverLines(state, offset, Math.min(state.totalLines, offset + limit - 1));
}

function rangesCoverLines(state: FileReadState, startLine: number, endLine: number): boolean {
  let coveredThrough = startLine - 1;
  for (const range of state.ranges ?? []) {
    if (range.endLine <= coveredThrough) continue;
    if (range.startLine > coveredThrough + 1) return false;
    coveredThrough = range.endLine;
    if (coveredThrough >= endLine) return true;
  }
  return false;
}

function mergeReadRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine);
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push({ ...range });
  }
  return merged;
}

async function resolveExistingPath(filePath: string, allowedDirectories: string[]): Promise<string> {
  const canonical = await realpath(filePath);
  assertAllowed(canonical, allowedDirectories);
  return canonical;
}

async function resolveWritePath(filePath: string, allowedDirectories: string[]): Promise<{ filePath: string; existing: boolean }> {
  try {
    return { filePath: await resolveExistingPath(filePath, allowedDirectories), existing: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let existingAncestor = filePath;
    const missingParts: string[] = [];
    while (true) {
      try {
        const canonicalAncestor = await realpath(existingAncestor);
        const resolvedPath = join(canonicalAncestor, ...missingParts);
        assertAllowed(resolvedPath, allowedDirectories);
        return { filePath: resolvedPath, existing: false };
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) throw ancestorError;
        missingParts.unshift(basename(existingAncestor));
        existingAncestor = parent;
      }
    }
  }
}

function assertAllowed(filePath: string, allowedDirectories: string[]): void {
  const allowed = allowedDirectories.some((directory) => {
    const child = relative(canonicalRoot(directory), filePath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new Error(`File is outside the project and added directories: ${filePath}`);
}

function canonicalRoot(directory: string): string {
  try { return realpathSync(directory); } catch { return directory; }
}

function resolvedFilePath(value: unknown, currentDirectory: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("file_path must be a non-empty string");
  const trimmed = value.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(currentDirectory, expanded);
}

function assertSupportedTextPath(filePath: string): void {
  if (UNSUPPORTED_READ_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error("File tools only support plain text files; images, PDFs, and notebooks are not supported");
  }
}

function integer(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return content ? 0 : 1;
  return content.split(needle).length - 1;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const existingMode = await stat(filePath).then((metadata) => metadata.mode).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    await writeFile(temporary, content, "utf8");
    if (existingMode !== undefined) await chmod(temporary, existingMode);
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File operation aborted");
  error.name = "AbortError";
  throw error;
}

function unifiedDiff(filePath: string, before: string, after: string, created = false): string {
  return createTwoFilesPatch(
    created ? "/dev/null" : `a${filePath}`,
    `b${filePath}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  ).trimEnd();
}

function isBlockedDevice(filePath: string): boolean {
  return BLOCKED_DEVICE_PATHS.has(filePath)
    || (filePath.startsWith("/proc/") && /\/fd\/[012]$/.test(filePath));
}
