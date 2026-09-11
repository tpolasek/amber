import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Standing guidance read from an AGENTS.md file. */
export interface UserInstructions {
  /** Trimmed file contents, absent when there is nothing to inject. */
  text?: string;
  /** Readable reason the file was skipped, absent when the file was fine or missing. */
  problem?: string;
}

export function userInstructionsPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".amber", "AGENTS.md");
}

export function projectInstructionsPath(directory: string): string {
  return join(directory, "AGENTS.md");
}

/**
 * Reads ~/.amber/AGENTS.md. A missing file is not a problem; an unreadable or
 * empty one is reported as a message rather than thrown, so a session still runs.
 */
export async function loadUserInstructions(homeDirectory = homedir()): Promise<UserInstructions> {
  const loaded = await readInstructions(userInstructionsPath(homeDirectory), "user instructions");
  return { ...(loaded.text ? { text: loaded.text } : {}), ...(loaded.problem ? { problem: loaded.problem } : {}) };
}

/**
 * Reads the nearest AGENTS.md from `directory` upward; the global ~/.amber one
 * is not a project file. Missing everywhere is not a problem.
 */
export async function loadProjectInstructions(directory: string, homeDirectory = homedir()): Promise<UserInstructions> {
  const globalPath = userInstructionsPath(homeDirectory);
  for (let current = directory; ;) {
    const path = projectInstructionsPath(current);
    if (path !== globalPath) {
      const loaded = await readInstructions(path, "project instructions");
      if (loaded.found) {
        return { ...(loaded.text ? { text: loaded.text } : {}), ...(loaded.problem ? { problem: loaded.problem } : {}) };
      }
    }
    const parent = dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

async function readInstructions(path: string, label: string): Promise<{ found: boolean; text?: string; problem?: string }> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return { found: false };
    return { found: true, problem: `Could not read ${path}: ${errorMessage(error)}` };
  }
  const text = source.trim();
  if (!text) return { found: true, problem: `${path} is empty, so no ${label} were loaded.` };
  return { found: true, text };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
