import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_DIRECTORY_COMPLETIONS = 40;

export interface DirectoryCompletion {
  value: string;
  absolutePath: string;
}

export interface FileCompletion extends DirectoryCompletion {
  kind: "directory" | "file";
}

export async function completeDirectories(
  fragment: string,
  baseDirectory: string,
  allowedRoots?: string[],
): Promise<DirectoryCompletion[]> {
  const completions = await completePathEntries(fragment, baseDirectory, "directories", allowedRoots);
  return completions.map(({ value, absolutePath }) => ({ value, absolutePath }));
}

export async function completeFiles(
  fragment: string,
  baseDirectory: string,
  allowedRoots?: string[],
): Promise<FileCompletion[]> {
  return completePathEntries(fragment, baseDirectory, "files", allowedRoots);
}

async function completePathEntries(
  fragment: string,
  baseDirectory: string,
  mode: "directories" | "files",
  allowedRoots?: string[],
): Promise<FileCompletion[]> {
  const parts = completionParts(fragment, baseDirectory);
  let parentDirectory: string;
  try {
    parentDirectory = await realpath(parts.parentCandidate);
    if (!(await stat(parentDirectory)).isDirectory()) return [];
  } catch {
    return [];
  }
  if (allowedRoots && !pathAllowed(parentDirectory, allowedRoots)) return [];

  let entries;
  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const prefix = parts.namePrefix.toLocaleLowerCase();
  const candidates = entries
    .filter((entry) => (prefix.startsWith(".") || !entry.name.startsWith("."))
      && entry.name.toLocaleLowerCase().startsWith(prefix)
      && (mode === "files" || entry.isDirectory() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name));

  const completions: FileCompletion[] = [];
  for (const entry of candidates) {
    if (completions.length >= MAX_DIRECTORY_COMPLETIONS) break;
    try {
      const absolutePath = await realpath(join(parentDirectory, entry.name));
      const entryStat = await stat(absolutePath);
      const kind = entryStat.isDirectory() ? "directory" : entryStat.isFile() ? "file" : undefined;
      if (!kind || mode === "directories" && kind !== "directory") continue;
      if (allowedRoots && !pathAllowed(absolutePath, allowedRoots)) continue;
      completions.push({
        value: `${parts.displayPrefix}${entry.name}${mode === "files" && kind === "directory" ? sep : ""}`,
        absolutePath,
        kind,
      });
    } catch {
      // Ignore entries that disappear or cannot be resolved while completing.
    }
  }
  return completions;
}

export async function completeDirectoryRoots(roots: string[]): Promise<DirectoryCompletion[]> {
  const completions: DirectoryCompletion[] = [];
  for (const root of roots) {
    try {
      const absolutePath = await realpath(root);
      if (!(await stat(absolutePath)).isDirectory()) continue;
      if (completions.some((existing) => existing.absolutePath === absolutePath)) continue;
      completions.push({ value: absolutePath, absolutePath });
    } catch {
      // Skip roots that no longer exist.
    }
  }
  return completions;
}

function completionParts(fragment: string, baseDirectory: string): {
  parentCandidate: string;
  displayPrefix: string;
  namePrefix: string;
} {
  if (fragment === "~" || fragment.startsWith(`~${sep}`)) {
    const homeRelative = fragment === "~" ? "" : fragment.slice(2);
    const lastSeparator = homeRelative.lastIndexOf(sep);
    const namePrefix = lastSeparator === -1 ? homeRelative : homeRelative.slice(lastSeparator + 1);
    const relativePrefix = lastSeparator === -1 ? "" : homeRelative.slice(0, lastSeparator + 1);
    return {
      parentCandidate: resolve(homedir(), relativePrefix || "."),
      displayPrefix: `~${sep}${relativePrefix}`,
      namePrefix,
    };
  }

  const lastSeparator = fragment.lastIndexOf(sep);
  const namePrefix = lastSeparator === -1 ? fragment : fragment.slice(lastSeparator + 1);
  const displayPrefix = lastSeparator === -1 ? "" : fragment.slice(0, lastSeparator + 1);
  const parentCandidate = isAbsolute(fragment)
    ? resolve(displayPrefix || sep)
    : resolve(baseDirectory, displayPrefix || ".");
  return { parentCandidate, displayPrefix, namePrefix };
}

function pathAllowed(candidate: string, roots: string[]): boolean {
  return roots.some((root) => {
    const child = relative(canonicalRoot(root), candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

function canonicalRoot(directory: string): string {
  try { return realpathSync(directory); } catch { return directory; }
}
