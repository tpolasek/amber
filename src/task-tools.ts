import type { ToolDefinition } from "./types.js";
import type { BackgroundTask, BackgroundTaskManager } from "./background-tasks.js";

export {
  PLANNING_TASK_TOOLS,
  TASK_CREATE_TOOL,
  TASK_GET_TOOL,
  TASK_LIST_TOOL,
  TASK_UPDATE_TOOL,
  executePlanningTaskTool,
  executeTaskCreate,
  executeTaskGet,
  executeTaskList,
  executeTaskUpdate,
  parseTaskCreateInput,
  parseTaskGetInput,
  parseTaskListInput,
  parseTaskUpdateInput,
} from "./planning-task-tools.js";
export type {
  PlanningTask,
  PlanningTaskResponse,
  PlanningTaskStatus,
  PlanningTaskSummary,
  TaskCreateInput,
  TaskUpdateInput,
} from "./planning-task-tools.js";

export const TASK_OUTPUT_TOOL: ToolDefinition = {
  name: "TaskOutput",
  description: "Retrieve output and status from a background task. Use block=true to wait for completion or block=false to check its current state.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The task ID to get output from." },
      block: { type: "boolean", default: true, description: "Whether to wait for completion. Defaults to true." },
      timeout: { type: "integer", minimum: 0, maximum: 600_000, default: 30_000, description: "Maximum wait time in milliseconds. Defaults to 30000." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export const TASK_STOP_TOOL: ToolDefinition = {
  name: "TaskStop",
  description: "Stop a running background task by ID.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The ID of the background task to stop." },
      shell_id: { type: "string", description: "Deprecated: use task_id instead." },
    },
    additionalProperties: false,
  },
};

export interface TaskOutputInput {
  taskId: string;
  block: boolean;
  timeoutMs: number;
}

export type BackgroundAgentStatus = "running" | "complete" | "error" | "stopped";

export interface BackgroundAgentTask {
  id: string;
  agentType: string;
  description: string;
  status: BackgroundAgentStatus;
  result: string;
  startedAt: string;
  completedAt?: string;
}

/** Resolves background agent sub-sessions by task ID. */
export interface BackgroundAgentSource {
  task(sessionId: string, taskId: string): Promise<BackgroundAgentTask | null>;
}

export function parseTaskOutputInput(input: Record<string, unknown>): TaskOutputInput {
  if (typeof input.task_id !== "string" || !input.task_id.trim()) throw new Error("TaskOutput task_id is required");
  if (input.block !== undefined && typeof input.block !== "boolean") throw new Error("TaskOutput block must be a boolean");
  const timeout = input.timeout ?? 30_000;
  if (!Number.isInteger(timeout) || (timeout as number) < 0 || (timeout as number) > 600_000) {
    throw new Error("TaskOutput timeout must be an integer from 0 to 600000");
  }
  return { taskId: input.task_id.trim(), block: input.block !== false, timeoutMs: timeout as number };
}

export function parseTaskStopInput(input: Record<string, unknown>): string {
  const id = input.task_id ?? input.shell_id;
  if (typeof id !== "string" || !id.trim()) throw new Error("Missing required parameter: task_id");
  return id.trim();
}

export async function executeTaskOutput(
  manager: BackgroundTaskManager,
  agents: BackgroundAgentSource,
  sessionId: string,
  input: TaskOutputInput,
  signal?: AbortSignal,
): Promise<{ output: string; resultText: string }> {
  if (manager.get(sessionId, input.taskId)) {
    const retrieval = await manager.output(sessionId, input.taskId, input.block, input.timeoutMs, signal);
    return {
      output: formatVisibleOutput(retrieval.task),
      resultText: formatTaskOutputResult(retrieval.retrievalStatus, retrieval.task),
    };
  }

  const agent = await retrieveAgentTask(agents, sessionId, input, signal);
  if (agent) {
    return {
      output: formatAgentVisibleOutput(agent.task),
      resultText: formatAgentTaskOutputResult(agent.retrievalStatus, agent.task),
    };
  }
  throw new Error(`No task found with ID: ${input.taskId}`);
}

interface AgentTaskRetrieval {
  retrievalStatus: "success" | "timeout" | "not_ready";
  task: BackgroundAgentTask;
}

const AGENT_POLL_INTERVAL_MS = 250;

async function retrieveAgentTask(
  agents: BackgroundAgentSource,
  sessionId: string,
  input: TaskOutputInput,
  signal?: AbortSignal,
): Promise<AgentTaskRetrieval | null> {
  const task = await agents.task(sessionId, input.taskId);
  if (!task) return null;
  if (task.status !== "running") return { retrievalStatus: "success", task };
  if (!input.block || input.timeoutMs <= 0) {
    return { retrievalStatus: input.block ? "timeout" : "not_ready", task };
  }

  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    await delay(Math.min(AGENT_POLL_INTERVAL_MS, deadline - Date.now()), signal);
    const current = await agents.task(sessionId, input.taskId);
    if (current && current.status !== "running") return { retrievalStatus: "success", task: current };
    if (Date.now() >= deadline) return { retrievalStatus: "timeout", task: current ?? task };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("TaskOutput aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function executeTaskStop(
  manager: BackgroundTaskManager,
  sessionId: string,
  taskId: string,
): { output: string; resultText: string } {
  const task = manager.stop(sessionId, taskId);
  const result = {
    message: `Successfully stopped task: ${task.id} (${task.command})`,
    task_id: task.id,
    task_type: task.type,
    command: task.command,
  };
  const text = JSON.stringify(result);
  return { output: text, resultText: text };
}

function formatVisibleOutput(task: BackgroundTask): string {
  const sections = [
    `status: ${task.status}`,
    ...(task.exitCode !== null ? [`exit code: ${task.exitCode}`] : []),
    ...(task.stdout ? [`stdout:\n${task.stdout}`] : []),
    ...(task.stderr ? [`stderr:\n${task.stderr}`] : []),
  ];
  return sections.join("\n\n");
}

function formatTaskOutputResult(retrievalStatus: "success" | "timeout" | "not_ready", task: BackgroundTask): string {
  const output = [task.stdout, task.stderr].filter(Boolean).join("\n");
  const parts = [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.id}</task_id>`,
    `<task_type>${task.type}</task_type>`,
    `<status>${task.status}</status>`,
    ...(task.exitCode !== null ? [`<exit_code>${task.exitCode}</exit_code>`] : []),
    ...(output.trim() ? [`<output>\n${output.trimEnd()}\n</output>`] : []),
  ];
  return parts.join("\n\n");
}

function agentStatusText(status: BackgroundAgentStatus): string {
  return status === "complete" ? "completed" : status === "error" ? "failed" : status === "stopped" ? "stopped" : "running";
}

function formatAgentVisibleOutput(task: BackgroundAgentTask): string {
  const sections = [
    `status: ${agentStatusText(task.status)}`,
    `agent: ${task.agentType}`,
    ...(task.result.trim() ? [`result:\n${task.result.trimEnd()}`] : []),
  ];
  return sections.join("\n\n");
}

function formatAgentTaskOutputResult(
  retrievalStatus: "success" | "timeout" | "not_ready",
  task: BackgroundAgentTask,
): string {
  const parts = [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.id}</task_id>`,
    `<task_type>agent</task_type>`,
    `<agent_type>${task.agentType}</agent_type>`,
    `<status>${agentStatusText(task.status)}</status>`,
    ...(task.description.trim() ? [`<summary>${task.description}</summary>`] : []),
    ...(task.result.trim() ? [`<output>\n${task.result.trimEnd()}\n</output>`] : []),
  ];
  return parts.join("\n\n");
}
