import type { BackgroundTaskManager } from "./background-tasks.js";
import { executeGrep, GREP_TOOL, parseGrepInput } from "./grep-tool.js";
import { executeGlob, GLOB_TOOL, parseGlobInput } from "./glob-tool.js";
import { executePlanningTaskTool, PLANNING_TASK_TOOLS } from "./planning-task-tools.js";
import {
  executeTaskOutput,
  executeTaskStop,
  parseTaskOutputInput,
  parseTaskStopInput,
  TASK_OUTPUT_TOOL,
  TASK_STOP_TOOL,
  type BackgroundAgentSource,
} from "./task-tools.js";
import type { Session, ToolCall } from "./types.js";

const regularToolNames = new Set([
  TASK_OUTPUT_TOOL.name,
  TASK_STOP_TOOL.name,
  GREP_TOOL.name,
  GLOB_TOOL.name,
  ...PLANNING_TASK_TOOLS.map((tool) => tool.name),
]);

export function isRegularTool(name: string): boolean {
  return regularToolNames.has(name);
}

export interface RegularToolContext {
  session: Session;
  sessionId: string;
  signal: AbortSignal;
  allowedDirectories: string[];
  currentDirectory: string;
  backgroundTasks: BackgroundTaskManager;
  backgroundAgentTasks: BackgroundAgentSource;
  onRunning: () => void;
}

export interface RegularToolResult {
  resultText: string;
  waiting: boolean;
  planningTasksUpdated: boolean;
  abortAfterResult?: Error;
}

export async function executeRegularTool(call: ToolCall, context: RegularToolContext): Promise<RegularToolResult> {
  const started = Date.now();
  call.status = "running";
  call.startedAt = new Date(started).toISOString();
  context.onRunning();

  let resultText = call.output;
  let waiting = false;
  let abortAfterResult: Error | undefined;
  const planningTasksUpdated = PLANNING_TASK_TOOLS.some((tool) => tool.name === call.name);
  try {
    if (call.name === TASK_OUTPUT_TOOL.name) {
      const result = await executeTaskOutput(
        context.backgroundTasks,
        context.backgroundAgentTasks,
        context.sessionId,
        parseTaskOutputInput(call.input),
        context.signal,
      );
      call.status = "complete";
      call.output = result.output;
      resultText = result.resultText;
      waiting = result.retrievalStatus === "timeout";
    } else if (call.name === TASK_STOP_TOOL.name) {
      const result = executeTaskStop(context.backgroundTasks, context.sessionId, parseTaskStopInput(call.input));
      call.status = "complete";
      call.output = result.output;
      resultText = result.resultText;
    } else if (planningTasksUpdated) {
      archiveCompletedPlanningTasks(context.session);
      const result = executePlanningTaskTool(call.name, call.input, context.session);
      archiveCompletedPlanningTasks(context.session);
      call.status = "complete";
      call.output = result.output;
      resultText = result.resultText;
    } else if (call.name === GREP_TOOL.name) {
      const result = await executeGrep(
        parseGrepInput(call.input),
        context.allowedDirectories,
        context.currentDirectory,
        context.signal,
      );
      call.status = "complete";
      call.output = result.output;
      call.workingDirectory = result.workingDirectory;
      resultText = result.resultText;
    } else if (call.name === GLOB_TOOL.name) {
      const result = await executeGlob(
        parseGlobInput(call.input),
        context.allowedDirectories,
        context.currentDirectory,
        context.signal,
      );
      call.status = "complete";
      call.output = result.output;
      call.workingDirectory = result.workingDirectory;
      resultText = result.resultText;
    }
  } catch (error) {
    call.status = "error";
    call.output = error instanceof Error ? error.message : "Unknown provider error";
    resultText = call.output;
    if (call.name === TASK_OUTPUT_TOOL.name && error instanceof Error && error.name === "AbortError") {
      abortAfterResult = error;
    }
  }
  call.durationMs = Date.now() - started;
  call.completedAt = new Date().toISOString();
  return { resultText, waiting, planningTasksUpdated, ...(abortAfterResult ? { abortAfterResult } : {}) };
}

function archiveCompletedPlanningTasks(session: Session): void {
  const tasks = session.planningTasks ?? [];
  if (tasks.length === 0 || tasks.some((task) => task.status !== "completed")) return;
  const highestTaskId = tasks.reduce((highest, task) => Math.max(highest, Number(task.id) || 0), 0);
  session.planningTaskArchiveHighWaterMark = Math.max(
    session.planningTaskArchiveHighWaterMark ?? 0,
    session.planningTaskHighWaterMark ?? 0,
    highestTaskId,
  );
}
