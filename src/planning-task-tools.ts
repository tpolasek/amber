import type { Session, ToolDefinition } from "./types.js";
import { taskNotFoundError } from "./task-errors.js";

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

const TASK_CREATE_PROMPT = `Create one item in the current session's planning task list. Created planning tasks receive numeric-string IDs for use with TaskGet and TaskUpdate; these IDs are not accepted by TaskOutput or TaskStop.

Use task tracking when several meaningful steps need coordination, when the user explicitly requests a task list, or when separate requested outcomes should be tracked independently. Skip it for simple, conversational, or informational work.

Give each task a concise imperative subject and a description of its concrete outcome. activeForm is the present-continuous label shown while the task is in progress. New tasks start as pending. Check TaskList when necessary to avoid duplicates, and use TaskUpdate to record dependencies or status changes.`;

const TASK_GET_PROMPT = `Retrieve one planning task's full details by its numeric-string ID, including its description, status, owner, metadata, and dependencies. TaskGet accepts planning task IDs only, not background Bash IDs beginning with b or linked background-agent session IDs. Use it before acting on a task when the TaskList summary does not contain enough context. Do not begin a task while its blockedBy list contains unresolved tasks.`;

const TASK_LIST_PROMPT = `List the current session's planning tasks with their numeric-string IDs, subjects, statuses, owners, and unresolved dependencies. Use this to check progress, avoid duplicates, or find pending work whose blockedBy list is empty. Use TaskGet when a task's full description or metadata is needed.`;

const TASK_UPDATE_PROMPT = `Update a planning task's status, details, owner, metadata, or dependencies. TaskUpdate accepts numeric-string planning task IDs only, not background Bash IDs beginning with b or linked background-agent session IDs.

Read the task's latest state with TaskGet before changing it. Move active work from pending to in_progress, and mark it completed only after its requested outcome is fully achieved and relevant verification passes. Leave unfinished or blocked work in progress. Use deleted only for a task that was created in error or is no longer relevant.

metadata merges keys into the existing object; a null value deletes a key. addBlocks and addBlockedBy add dependency relationships.`;

export const TASK_CREATE_TOOL: ToolDefinition = {
  name: "TaskCreate",
  description: TASK_CREATE_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "A brief title for the task" },
      description: { type: "string", description: "What needs to be done" },
      activeForm: { type: "string", description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")' },
      metadata: { type: "object", additionalProperties: true, description: "Arbitrary metadata to attach to the task" },
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
      taskId: { type: "string", description: "Numeric-string planning task ID returned by TaskCreate or TaskList" },
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
      taskId: { type: "string", description: "Numeric-string planning task ID returned by TaskCreate or TaskList" },
      subject: { type: "string", description: "New subject for the task" },
      description: { type: "string", description: "New description for the task" },
      activeForm: { type: "string", description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")' },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status for the task" },
      addBlocks: { type: "array", items: { type: "string" }, description: "Task IDs that this task blocks" },
      addBlockedBy: { type: "array", items: { type: "string" }, description: "Task IDs that block this task" },
      owner: { type: "string", description: "New owner for the task" },
      metadata: { type: "object", additionalProperties: true, description: "Metadata keys to merge into the task. Set a key to null to delete it." },
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

export function executeTaskGet(session: Session, taskId: string): PlanningTaskToolResult<PlanningTaskResponse> {
  const task = findTask(session, taskId);
  if (!task) throw taskNotFoundError(taskId);
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

export function executeTaskUpdate(session: Session, input: TaskUpdateInput): PlanningTaskToolResult<PlanningTaskResponse> {
  const task = findTask(session, input.taskId);
  if (!task) throw taskNotFoundError(input.taskId);

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
