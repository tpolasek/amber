import { formatDuration } from "./client-formatters.js";
import type { ToolCall } from "./types.js";

const MAX_INLINE_TOOL_SUBJECT_LENGTH = 80;

export function shouldRenderToolOutput(call: ToolCall): boolean {
  if (call.name === "EnterPlanMode" || call.name === "ExitPlanMode") return false;
  return Boolean(call.output) && !(call.name === "Bash" && call.output === "(no output)");
}

export function shouldExpandToolOutput(isDiff: boolean): boolean {
  return isDiff;
}

export function isDiffOutput(call: ToolCall): boolean {
  return call.status === "complete" && (call.name === "Write" || call.name === "Edit")
    && call.output.startsWith("--- ") && call.output.includes("\n+++ ");
}

export function diffSummary(diff: string): string {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return `Diff · +${added.toLocaleString()} −${removed.toLocaleString()}`;
}

export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "diff-header";
  if (line.startsWith("+")) return "diff-addition";
  if (line.startsWith("-")) return "diff-deletion";
  return "diff-context";
}

export function toolStatusLabel(call: ToolCall, now = Date.now()): string {
  if (call.name === "Agent" && call.status === "complete" && call.durationMs !== undefined) {
    return `AGENT COMPLETE · ${formatDuration(call.durationMs)}`;
  }
  if (call.statusDisplay) {
    const elapsed = call.statusDisplay.appendElapsed && call.startedAt
      ? ` ${formatDuration(Math.max(0, now - Date.parse(call.startedAt)))}`
      : "";
    return `${call.statusDisplay.text}${elapsed}`;
  }
  if (call.status === "running") return "RUNNING…";
  if (call.status === "timed_out") return "TIMED OUT";
  if (call.status === "complete") return "COMPLETE";
  if (call.status === "error") return "FAILED";
  return "QUEUED";
}

export function toolSubject(call: ToolCall): string {
  if (call.name === "EnterPlanMode") return "Request browser approval to begin planning";
  if (call.name === "ExitPlanMode") return "Review the saved implementation plan";
  if (call.name === "AskUserQuestion") {
    const questions = Array.isArray(call.input.questions) ? call.input.questions : [];
    const first = questions[0];
    return first && typeof first === "object" && typeof (first as { question?: unknown }).question === "string"
      ? (first as { question: string }).question
      : "Preparing questions…";
  }
  if (call.name === "Bash") return typeof call.input.command === "string" ? call.input.command : "Preparing tool input…";
  if (call.name === "Agent") {
    if (typeof call.input.description === "string") return call.input.description;
    return typeof call.input.prompt === "string" ? call.input.prompt : "Preparing agent input…";
  }
  if (call.name === "TaskOutput" || call.name === "TaskStop") {
    const taskId = call.input.task_id ?? call.input.shell_id;
    return typeof taskId === "string" ? taskId : "Preparing task ID…";
  }
  if (call.name === "Skill") {
    if (typeof call.input.skill !== "string") return "Preparing skill…";
    const name = `/${call.input.skill.replace(/^\/+/, "")}`;
    if (typeof call.input.args !== "string" || !call.input.args.trim()) return name;
    return `${name} ${call.input.args.trim().split(/\s+/).map((token) => `"${token}"`).join(" ")}`;
  }
  if (call.name === "Grep" || call.name === "Glob") {
    const pattern = typeof call.input.pattern === "string" ? call.input.pattern : "";
    if (!pattern) return call.name === "Glob" ? "Preparing glob pattern…" : "Preparing search pattern…";
    const path = typeof call.input.path === "string" ? call.input.path.trim() : "";
    return path ? `${pattern} in ${path}` : pattern;
  }
  return call.filePath ?? (typeof call.input.file_path === "string" ? call.input.file_path : "Preparing file path…");
}

export function shouldInlineToolSubject(subject: string): boolean {
  return subject.length <= MAX_INLINE_TOOL_SUBJECT_LENGTH && !subject.includes("\n");
}

export function toolMetadata(call: ToolCall): string {
  const values: string[] = [];
  if (call.name === "Agent") {
    const type = call.agentType ?? (typeof call.input.subagent_type === "string" ? call.input.subagent_type : "default");
    const model = call.agentModel ?? (typeof call.input.model === "string" ? call.input.model : undefined);
    values.push(model ? `${type} · ${model}` : type);
  }
  if (call.name !== "Bash" && call.workingDirectory) values.push(call.workingDirectory);
  if (call.name === "Skill") {
    if (call.skillModel) values.push(call.skillModel);
    if (call.skillEffort) values.push(`effort ${call.skillEffort}`);
  }
  if (call.name === "Bash" && call.exitCode !== undefined && call.exitCode !== null && call.exitCode !== 0) {
    if (call.timeoutMs !== undefined) values.push(`timeout ${formatDuration(call.timeoutMs)}`);
    values.push(`exit ${call.exitCode}`);
  }
  return values.join(" · ");
}
