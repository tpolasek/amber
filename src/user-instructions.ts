import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Standing user guidance, read from ~/.amber/AGENTS.md. */
export interface UserInstructions {
  /** Trimmed file contents, absent when there is nothing to inject. */
  text?: string;
  /** Readable reason the file was skipped, absent when the file was fine or missing. */
  problem?: string;
}

export function userInstructionsPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".amber", "AGENTS.md");
}

/**
 * Reads ~/.amber/AGENTS.md. A missing file is not a problem; an unreadable or
 * empty one is reported as a message rather than thrown, so a session still runs.
 */
export async function loadUserInstructions(homeDirectory = homedir()): Promise<UserInstructions> {
  const path = userInstructionsPath(homeDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    return { problem: `Could not read ${path}: ${errorMessage(error)}` };
  }
  const text = source.trim();
  if (!text) return { problem: `${path} is empty, so no user instructions were loaded.` };
  return { text };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
