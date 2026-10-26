// src/cli/diff.ts
import type { ToolCall } from "../types.js";
import { DIM, GREEN, RED, displayWidth } from "./render.js";

/** Edit/Write outputs are unified diffs with 3 context lines per hunk. They
 *  ride along in the tool_update event either way, so printing them costs no
 *  extra bandwidth; only the terminal stays bounded. */
const MAX_LINES = 400;
const INDENT = "  ";

export function isDiffCall(call: ToolCall): boolean {
  return call.status === "complete" && (call.name === "Edit" || call.name === "Write")
    && call.output.startsWith("--- ") && call.output.includes("\n+++ ");
}

export interface DiffLine {
  text: string;
  codes: string; // "" prints unstyled
}

export function diffLines(diff: string, width: number): DiffLine[] {
  const budget = Math.max(10, width - INDENT.length);
  const lines = diff.split("\n").filter((line) => line !== "");
  const out: DiffLine[] = [];
  for (const line of lines.slice(0, MAX_LINES)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue; // the tool line already names the path
    const codes = line.startsWith("+") ? GREEN : line.startsWith("-") ? RED : DIM;
    out.push({ text: INDENT + clipWidth(line, budget), codes });
  }
  if (lines.length > MAX_LINES) {
    out.push({ text: `${INDENT}… ${lines.length - MAX_LINES} more lines`, codes: DIM });
  }
  return out;
}

function clipWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > max - 1) return `${out}…`;
    out += character;
    width += characterWidth;
  }
  return out;
}
