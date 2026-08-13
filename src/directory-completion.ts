import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_DIRECTORY_COMPLETIONS = 40;

export interface DirectoryCompletion {
  value: string;
  absolutePath: string;
}

export async function completeDirectories(
  fragment: string,
  baseDirectory: string,
  allowedRoots?: string[],
): Promise<DirectoryCompletion[]> {
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
      && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name));

  const completions: DirectoryCompletion[] = [];
  for (const entry of candidates) {
    if (completions.length >= MAX_DIRECTORY_COMPLETIONS) break;
    try {
      const absolutePath = await realpath(join(parentDirectory, entry.name));
      if (!(await stat(absolutePath)).isDirectory()) continue;
      if (allowedRoots && !pathAllowed(absolutePath, allowedRoots)) continue;
      completions.push({ value: `${parts.displayPrefix}${entry.name}`, absolutePath });
    } catch {
      // Ignore entries that disappear or cannot be resolved while completing.
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
