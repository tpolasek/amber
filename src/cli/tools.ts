import { homedir } from "node:os";
import type { ToolCall } from "../types.js";
import { formatTokenCountInThousands } from "../client-formatters.js";
import type { Run } from "./render.js";
import type { Theme } from "./theme.js";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const flat = collapse(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function displayPath(path: string): string {
  const home = homedir();
  const shown = path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  return truncate(shown, 60);
}

function argumentOf(call: ToolCall): string {
  const input = call.input ?? {};
  const firstString = Object.values(input).find((value) => typeof value === "string");
  switch (call.name) {
    case "Bash": return truncate(String(input.command ?? ""), 60);
    case "Read": {
      const range = call.readRange;
      const path = displayPath(String(input.file_path ?? ""));
      return range ? `${path} L${range.startLine}-${range.endLine}` : path;
    }
    case "Edit":
    case "Write": return displayPath(String(input.file_path ?? ""));
    case "Glob":
    case "Grep": return truncate(String(input.pattern ?? ""), 60);
    case "Agent": return truncate(String(input.description ?? ""), 60);
    case "Skill": return truncate(String(input.skill ?? input.name ?? ""), 60);
    default: return firstString === undefined ? "" : truncate(firstString, 40);
  }
}

/** File tools finish in milliseconds; the payload size says more than 0.0s does. */
const CONTENT_TOOLS = new Set(["Edit", "Read", "Write"]);

function contentKilotokens(call: ToolCall): string {
  let characters = call.output.length;
  for (const value of Object.values(call.input)) {
    if (typeof value === "string") characters += value.length;
  }
  const tokens = Math.ceil(characters / 4);
  return `${formatTokenCountInThousands(tokens)}kt`;
}

export function toolLine(call: ToolCall, theme: Theme): Run[] {
  const ok = call.status === "complete";
  const runs: Run[] = [{ text: ok ? "✓" : "✗", codes: ok ? theme.toolOk : theme.toolErr }];
  if (call.name !== "") runs.push({ text: ` ${call.name}`, codes: theme.toolName });
  const argument = argumentOf(call);
  if (argument !== "") runs.push({ text: ` ${argument}`, codes: theme.toolArg });
  for (const tail of tailRuns(call, theme)) runs.push({ text: " · ", codes: theme.toolTail }, tail);
  return runs;
}

function tailRuns(call: ToolCall, theme: Theme): Run[] {
  const tails: Run[] = [];
  if (call.status === "timed_out") tails.push({ text: "timed out", codes: theme.toolErr });
  else if (call.status === "error") tails.push({ text: truncate(firstLine(call.output), 80), codes: theme.toolErr });
  else if (call.name === "Bash" && call.exitCode !== undefined && call.exitCode !== null) {
    const failed = call.exitCode !== 0;
    tails.push({ text: `exit ${call.exitCode}`, codes: failed ? theme.toolErr : theme.toolTail });
  }
  if (call.durationMs !== undefined && call.status !== "running" && call.status !== "queued") {
    const size = CONTENT_TOOLS.has(call.name) ? contentKilotokens(call) : `${(call.durationMs / 1_000).toFixed(1)}s`;
    tails.push({ text: size, codes: theme.toolTail });
  }
  return tails;
}

/** The running-tool segment of the status line, colored like a printed tool line. */
export function toolStatusRuns(call: ToolCall, theme: Theme): Run[] {
  const runs: Run[] = [];
  if (call.name !== "") runs.push({ text: call.name, codes: theme.toolName });
  const budget = Math.max(0, 60 - call.name.length - 1);
  const argument = argumentOf(call);
  if (argument !== "" && budget > 0) runs.push({ text: ` ${truncate(argument, budget)}`, codes: theme.toolArg });
  return runs;
}

function firstLine(output: string): string {
  return output.split("\n", 1)[0] ?? "";
}
