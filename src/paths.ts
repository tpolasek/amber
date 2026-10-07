import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** True when `path` is `directory` itself or lies underneath it. */
export function isWithinDirectory(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function isWithinAnyDirectory(path: string, directories: string[]): boolean {
  return directories.some((directory) => isWithinDirectory(path, directory));
}

export function joinHome(requested: string): string {
  return requested === "~" ? homedir() : resolve(homedir(), requested.slice(2));
}

/** Displays an absolute path relative to `currentDirectory`, falling back to the absolute form. */
export function toRelativePath(filePath: string, currentDirectory: string): string {
  const rel = relative(currentDirectory, filePath);
  if (rel === "") return ".";
  return rel && !isAbsolute(rel) && !rel.startsWith("..") ? rel : filePath;
}

/**
 * Canonicalizes a requested search path for the Glob/Grep tools: `~`-relative
 * paths expand, relative paths resolve against `currentDirectory`, and the
 * result must exist and stay inside the allowed directories.
 */
export async function resolveSearchPath(
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
  if (!isWithinAnyDirectory(canonical, canonicalAllowed)) {
    throw new Error(`Search path is outside the project and added directories: ${canonical}`);
  }
  return canonical;
}
