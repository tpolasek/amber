import type { Session, ToolDefinition } from "./types.js";

export type PlanningTaskStatus = "pending" | "in_progress" | "completed";
export type PlanningTaskResponseStatus = PlanningTaskStatus | "deleted";

export interface PlanningTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: PlanningTaskStatus;
  owner: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
}

export interface PlanningTaskResponse extends Omit<PlanningTask, "activeForm" | "status"> {
  status: PlanningTaskResponseStatus;
}

export interface PlanningTaskSummary {
  id: string;
  subject: string;
  status: PlanningTaskStatus;
  owner: string;
  blockedBy: string[];
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm: string;
  metadata: Record<string, unknown>;
}

export interface TaskUpdateInput {
  taskId: string;
  status?: PlanningTaskResponseStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export interface PlanningTaskToolResult<T> {
  data: T;
  output: string;
  resultText: string;
}

const TASK_CREATE_PROMPT = `Use this tool to create a structured task in the task list. Tasks are useful for complex multi-step work, non-trivial implementations, plan-mode tracking, and user-requested todo lists. Do not create tasks for a single straightforward action or purely informational conversation.

Use a short, actionable subject in imperative form and include enough context and requirements in the description for someone else to complete the work. activeForm is the present-continuous text shown while work is in progress and defaults to subject. New tasks start pending with no owner or dependencies. Check TaskList first to avoid duplicates.`;

const TASK_GET_PROMPT = `Retrieve the full current state of one task by ID. Use this before updating a task, when starting assigned work, or when you need its description, owner, dependencies, or metadata. Check blockedBy before beginning work and use TaskList for a summary of every task.`;

const TASK_LIST_PROMPT = `List all tasks in summary form. Use this to check progress, avoid duplicate tasks, find pending work, and see which tasks are blocked. Prefer available tasks in ascending ID order. After completing a task, list tasks again to find newly unblocked work. Use TaskGet for descriptions, outgoing dependencies, and metadata.`;

const TASK_UPDATE_PROMPT = `Update only the specified fields of an existing task. Read the latest task with TaskGet first. Use status pending, in_progress, or completed for the normal workflow; deleted permanently removes the task. Mark a task completed only when its work is fully accomplished and verification passes. Keep incomplete or blocked work in progress and create a separate task for a newly discovered blocker.

metadata is merged into existing metadata; set a key to null to delete it. addBlocks adds tasks that must wait for this task, while addBlockedBy adds tasks that must finish before this task can proceed.`;

export const TASK_CREATE_TOOL: ToolDefinition = {
  name: "TaskCreate",
  description: TASK_CREATE_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Short, actionable title in imperative form." },
      description: { type: "string", description: "Detailed context and requirements for the task." },
      activeForm: { type: "string", description: "Present-continuous spinner text. Defaults to subject." },
      metadata: { type: "object", additionalProperties: true, description: "Arbitrary metadata attached to the task. Defaults to an empty object." },
    },
    required: ["subject", "description"],
    additionalProperties: false,
  },
};

export const TASK_GET_TOOL: ToolDefinition = {
  name: "TaskGet",
  description: TASK_GET_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The ID of the task to retrieve." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
};

export const TASK_LIST_TOOL: ToolDefinition = {
  name: "TaskList",
  description: TASK_LIST_PROMPT,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const TASK_UPDATE_TOOL: ToolDefinition = {
  name: "TaskUpdate",
  description: TASK_UPDATE_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The ID of the task to update." },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New task status." },
      subject: { type: "string", description: "New imperative-form task title." },
      description: { type: "string", description: "Replacement task description." },
      activeForm: { type: "string", description: "New present-continuous spinner text." },
      owner: { type: "string", description: "New task owner; use an empty string to unassign." },
      metadata: { type: "object", additionalProperties: true, description: "Metadata to merge. A null value deletes that key." },
      addBlocks: { type: "array", items: { type: "string" }, description: "Task IDs that this task now blocks." },
      addBlockedBy: { type: "array", items: { type: "string" }, description: "Task IDs that now block this task." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
};

export const PLANNING_TASK_TOOLS = [TASK_CREATE_TOOL, TASK_GET_TOOL, TASK_LIST_TOOL, TASK_UPDATE_TOOL];

export function parseTaskCreateInput(input: Record<string, unknown>): TaskCreateInput {
  const subject = requiredText(input.subject, "TaskCreate subject");
  const description = requiredText(input.description, "TaskCreate description");
  const activeForm = input.activeForm === undefined
    ? subject
    : requiredText(input.activeForm, "TaskCreate activeForm");
  const metadata = input.metadata === undefined
    ? {}
    : metadataObject(input.metadata, "TaskCreate metadata");
  return { subject, description, activeForm, metadata };
}

export function parseTaskGetInput(input: Record<string, unknown>): string {
  return requiredText(input.taskId, "TaskGet taskId");
}

export function parseTaskListInput(input: Record<string, unknown>): void {
  if (Object.keys(input).length > 0) throw new Error("TaskList does not accept parameters");
}

export function parseTaskUpdateInput(input: Record<string, unknown>): TaskUpdateInput {
  const parsed: TaskUpdateInput = { taskId: requiredText(input.taskId, "TaskUpdate taskId") };
  if (input.status !== undefined) {
    if (!isResponseStatus(input.status)) {
      throw new Error("TaskUpdate status must be pending, in_progress, completed, or deleted");
    }
    parsed.status = input.status;
  }
  if (input.subject !== undefined) parsed.subject = requiredText(input.subject, "TaskUpdate subject");
  if (input.description !== undefined) parsed.description = requiredText(input.description, "TaskUpdate description");
  if (input.activeForm !== undefined) parsed.activeForm = requiredText(input.activeForm, "TaskUpdate activeForm");
  if (input.owner !== undefined) {
    if (typeof input.owner !== "string") throw new Error("TaskUpdate owner must be a string");
    parsed.owner = input.owner.trim();
  }
  if (input.metadata !== undefined) parsed.metadata = metadataObject(input.metadata, "TaskUpdate metadata");
  if (input.addBlocks !== undefined) parsed.addBlocks = taskIds(input.addBlocks, "TaskUpdate addBlocks");
  if (input.addBlockedBy !== undefined) parsed.addBlockedBy = taskIds(input.addBlockedBy, "TaskUpdate addBlockedBy");
  return parsed;
}

export function executeTaskCreate(session: Session, input: TaskCreateInput): PlanningTaskToolResult<PlanningTaskResponse> {
  const highestExistingId = planningTasks(session).reduce((highest, task) => Math.max(highest, numericId(task.id)), 0);
  const highWaterMark = Math.max(session.planningTaskHighWaterMark ?? 0, highestExistingId) + 1;
  session.planningTaskHighWaterMark = highWaterMark;
  const task: PlanningTask = {
    id: String(highWaterMark),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: "pending",
    owner: "",
    blocks: [],
    blockedBy: [],
    metadata: cloneRecord(input.metadata),
  };
  (session.planningTasks ??= []).push(task);
  return jsonResult(visibleTask(task));
}

export function executeTaskGet(session: Session, taskId: string): PlanningTaskToolResult<PlanningTaskResponse | null> {
  const task = findTask(session, taskId);
  if (!task) return { data: null, output: "Task not found", resultText: "Task not found" };
  return jsonResult(visibleTask(task));
}

export function executeTaskList(session: Session): PlanningTaskToolResult<PlanningTaskSummary[]> {
  const tasks = planningTasks(session);
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  const summaries = [...tasks]
    .sort((left, right) => numericId(left.id) - numericId(right.id))
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      blockedBy: task.blockedBy.filter((id) => !completed.has(id)),
    }));
  return jsonResult(summaries);
}

export function executeTaskUpdate(session: Session, input: TaskUpdateInput): PlanningTaskToolResult<PlanningTaskResponse | null> {
  const task = findTask(session, input.taskId);
  if (!task) return { data: null, output: "Task not found", resultText: "Task not found" };

  if (input.status === "deleted") {
    const deleted = visibleTask({ ...task, status: task.status });
    deleted.status = "deleted";
    session.planningTasks = planningTasks(session).filter((candidate) => candidate.id !== task.id);
    for (const candidate of session.planningTasks) {
      candidate.blocks = candidate.blocks.filter((id) => id !== task.id);
      candidate.blockedBy = candidate.blockedBy.filter((id) => id !== task.id);
    }
    return jsonResult(deleted);
  }

  if (input.subject !== undefined) task.subject = input.subject;
  if (input.description !== undefined) task.description = input.description;
  if (input.activeForm !== undefined) task.activeForm = input.activeForm;
  if (input.owner !== undefined) task.owner = input.owner;
  if (input.status !== undefined) task.status = input.status;
  if (input.metadata !== undefined) task.metadata = mergeMetadata(task.metadata, input.metadata);

  for (const blockedId of input.addBlocks ?? []) addDependency(session, task.id, blockedId);
  for (const blockerId of input.addBlockedBy ?? []) addDependency(session, blockerId, task.id);
  return jsonResult(visibleTask(task));
}

export function executePlanningTaskTool(
  name: string,
  input: Record<string, unknown>,
  session: Session,
): PlanningTaskToolResult<unknown> {
  if (name === TASK_CREATE_TOOL.name) return executeTaskCreate(session, parseTaskCreateInput(input));
  if (name === TASK_GET_TOOL.name) return executeTaskGet(session, parseTaskGetInput(input));
  if (name === TASK_LIST_TOOL.name) {
    parseTaskListInput(input);
    return executeTaskList(session);
  }
  if (name === TASK_UPDATE_TOOL.name) return executeTaskUpdate(session, parseTaskUpdateInput(input));
  throw new Error(`Unknown planning task tool: ${name}`);
}

function planningTasks(session: Session): PlanningTask[] {
  return session.planningTasks ?? [];
}

function findTask(session: Session, taskId: string): PlanningTask | undefined {
  return planningTasks(session).find((task) => task.id === taskId);
}

function addDependency(session: Session, blockerId: string, blockedId: string): void {
  const blocker = findTask(session, blockerId);
  const blocked = findTask(session, blockedId);
  if (!blocker || !blocked) return;
  if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
}

function visibleTask(task: PlanningTask): PlanningTaskResponse {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.owner,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    metadata: cloneRecord(task.metadata),
  };
}

function mergeMetadata(existing: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const entries = new Map(Object.entries(existing));
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) entries.delete(key);
    else entries.set(key, structuredClone(value));
  }
  return Object.fromEntries(entries);
}

function metadataObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return cloneRecord(value as Record<string, unknown>);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, structuredClone(entry)]));
}

function taskIds(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of task IDs`);
  const ids = value.map((entry) => requiredText(entry, `${name} task ID`));
  return [...new Set(ids)];
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function isResponseStatus(value: unknown): value is PlanningTaskResponseStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

function numericId(id: string): number {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function jsonResult<T>(data: T): PlanningTaskToolResult<T> {
  const text = JSON.stringify(data);
  return { data, output: text, resultText: text };
}
