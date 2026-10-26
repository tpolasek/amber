import { homedir } from "node:os";
import type { ToolCall } from "../types.js";
import { formatTokenCountInThousands } from "../client-formatters.js";

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

export function toolLine(call: ToolCall): string {
  const glyph = call.status === "complete" ? "✓" : "✗";
  const head = [glyph, call.name, argumentOf(call)].filter((part) => part !== "").join(" ");
  const tail: string[] = [];
  if (call.status === "timed_out") tail.push("timed out");
  else if (call.status === "error") tail.push(truncate(firstLine(call.output), 80));
  else if (call.name === "Bash" && call.exitCode !== undefined && call.exitCode !== null) {
    tail.push(`exit ${call.exitCode}`);
  }
  if (call.durationMs !== undefined && call.status !== "running" && call.status !== "queued") {
    tail.push(CONTENT_TOOLS.has(call.name) ? contentKilotokens(call) : `${(call.durationMs / 1_000).toFixed(1)}s`);
  }
  return tail.length === 0 ? head : `${head} · ${tail.join(" · ")}`;
}

export function toolStatus(call: ToolCall): string {
  return [call.name, argumentOf(call)].filter((part) => part !== "").join(" ").slice(0, 60);
}

function firstLine(output: string): string {
  return output.split("\n", 1)[0] ?? "";
}
