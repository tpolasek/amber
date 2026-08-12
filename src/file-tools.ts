import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { FileReadState, Session, ToolDefinition } from "./types.js";

const MAX_LINES_TO_READ = 2_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_CHARACTERS = 100_000;
const MAX_EDIT_BYTES = 1024 * 1024 * 1024;
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full", "/dev/stdin", "/dev/tty", "/dev/console",
  "/dev/stdout", "/dev/stderr", "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
]);
const UNSUPPORTED_READ_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ipynb"]);

export const READ_TOOL: ToolDefinition = {
  name: "Read",
  description: `Read a text file from the local filesystem. The file_path must be absolute. By default this reads up to ${MAX_LINES_TO_READ} lines from line 1. Results use cat -n style line numbers. Use offset and limit for large files. Read files, not directories.`,
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read." },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LINES_TO_READ, description: "Maximum lines to read." },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
};

export const WRITE_TOOL: ToolDefinition = {
  name: "Write",
  description: "Write a file to the local filesystem. The file_path must be absolute. Existing files must first be fully read with Read and must not have changed since that read. Prefer Edit for small changes; Write replaces the complete file.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to create or overwrite." },
      content: { type: "string", description: "Complete new file content." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
};

export const EDIT_TOOL: ToolDefinition = {
  name: "Edit",
  description: "Perform an exact string replacement in a text file. The file must first be fully read with Read and must not have changed. old_string must be unique unless replace_all is true. Never include Read's line-number prefix in old_string.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to modify." },
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
}

export async function executeFileTool(
  name: string,
  input: Record<string, unknown>,
  allowedDirectories: string[],
  session: Session,
): Promise<FileToolResult> {
  if (name === READ_TOOL.name) return readTextFile(input, allowedDirectories, session);
  if (name === WRITE_TOOL.name) return writeTextFile(input, allowedDirectories, session);
  if (name === EDIT_TOOL.name) return editTextFile(input, allowedDirectories, session);
  throw new Error(`Unknown file tool: ${name}`);
}

async function readTextFile(
  input: Record<string, unknown>,
  allowedDirectories: string[],
  session: Session,
): Promise<FileToolResult> {
  const requestedPath = requiredAbsolutePath(input.file_path);
  assertSupportedTextPath(requestedPath);
  if (isBlockedDevice(requestedPath)) throw new Error(`Cannot read '${requestedPath}': this device file would block or produce infinite output.`);
  const filePath = await resolveExistingPath(requestedPath, allowedDirectories);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`Read only supports files, not directories: ${filePath}`);
  if (metadata.size > MAX_READ_BYTES && input.limit === undefined) {
    throw new Error(`File is too large to read (${metadata.size.toLocaleString()} bytes). Use offset and limit to read a specific portion.`);
  }
  const offset = integer(input.offset, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
  const limit = integer(input.limit, "limit", 1, MAX_LINES_TO_READ, MAX_LINES_TO_READ);
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) throw new Error("Read only supports text files in this version of AMBER");
  const content = buffer.toString("utf8").replaceAll("\r\n", "\n");
  const lines = splitLines(content);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  if (selected.reduce((total, line) => total + line.length + 1, 0) > MAX_READ_CHARACTERS) {
    throw new Error("File content exceeds the 25,000-token read limit. Use a smaller offset and limit range.");
  }
  const full = offset === 1 && selected.length === lines.length;
  (session.fileReadState ??= {})[filePath] = readState(buffer, metadata.mtimeMs, full);

  const numbered = selected.map((line, index) => `${String(offset + index).padStart(6)}→${line}`).join("\n");
  const resultText = numbered || (lines.length === 0
    ? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
    : `<system-reminder>Warning: the file is shorter than offset ${offset}. It has ${lines.length} lines.</system-reminder>`);
  return {
    filePath,
    output: `Read ${selected.length.toLocaleString()} ${selected.length === 1 ? "line" : "lines"}`,
    resultText,
  };
}

async function writeTextFile(
  input: Record<string, unknown>,
  allowedDirectories: string[],
  session: Session,
): Promise<FileToolResult> {
  const requestedPath = requiredAbsolutePath(input.file_path);
  assertSupportedTextPath(requestedPath);
  if (typeof input.content !== "string") throw new Error("Write requires string content");
  const { filePath, existing } = await resolveWritePath(requestedPath, allowedDirectories);
  if (existing) {
    if (!(await stat(filePath)).isFile()) throw new Error(`Write only supports files: ${filePath}`);
    await requireFreshFullRead(filePath, session);
  }
  const oldContent = existing ? await readFile(filePath, "utf8") : "";
  await atomicWrite(filePath, input.content);
  await updateReadState(filePath, session);
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
  session: Session,
): Promise<FileToolResult> {
  const requestedPath = requiredAbsolutePath(input.file_path);
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
    await updateReadState(filePath, session);
    return {
      filePath,
      output: unifiedDiff(filePath, "", input.new_string, true),
      resultText: `File created successfully at: ${filePath}`,
    };
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`Edit only supports files: ${filePath}`);
  if (metadata.size > MAX_EDIT_BYTES) throw new Error("File is too large to edit");
  await requireFreshFullRead(filePath, session);
  const rawOriginal = await readFile(filePath, "utf8");
  if (rawOriginal.includes("\0")) throw new Error("Edit only supports text files in this version of AMBER");
  const usesCrlf = rawOriginal.includes("\r\n");
  const original = rawOriginal.replaceAll("\r\n", "\n");
  const oldString = input.old_string;
  if (oldString === "" && original !== "") throw new Error("Cannot create new file: file already exists and is not empty.");
  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  const replaceAll = input.replace_all === true;
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`Found ${occurrences} matches of the string to replace, but replace_all is false. Set replace_all to true or provide more context.`);
  }
  const updated = replaceAll ? original.replaceAll(oldString, input.new_string) : original.replace(oldString, input.new_string);
  await atomicWrite(filePath, usesCrlf ? updated.replaceAll("\n", "\r\n") : updated);
  await updateReadState(filePath, session);
  return {
    filePath,
    output: unifiedDiff(filePath, original, updated),
    resultText: replaceAll
      ? `The file ${filePath} has been updated. All ${occurrences} occurrences were successfully replaced.`
      : `The file ${filePath} has been updated successfully.`,
  };
}

async function requireFreshFullRead(filePath: string, session: Session): Promise<void> {
  const prior = session.fileReadState?.[filePath];
  if (!prior?.full) throw new Error("File has not been fully read yet. Read it first before writing to it.");
  const metadata = await stat(filePath);
  const current = await readFile(filePath);
  if (metadata.size !== prior.size || hash(current) !== prior.hash) {
    throw new Error("File has been modified since read. Read it again before attempting to write it.");
  }
}

async function updateReadState(filePath: string, session: Session): Promise<void> {
  const [buffer, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  (session.fileReadState ??= {})[filePath] = readState(buffer, metadata.mtimeMs, true);
}

function readState(buffer: Buffer, mtimeMs: number, full: boolean): FileReadState {
  return { mtimeMs, size: buffer.length, hash: hash(buffer), full };
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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
    const child = relative(directory, filePath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new Error(`File is outside the project and added directories: ${filePath}`);
}

function requiredAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("file_path must be a non-empty string");
  if (!isAbsolute(value)) throw new Error("file_path must be absolute, not relative");
  return value;
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
