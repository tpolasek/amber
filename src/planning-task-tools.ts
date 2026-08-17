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

const TASK_CREATE_PROMPT = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user explicitly asks you to use the todo list
- User provides multiple tasks to be done - When the user provides multiple tasks to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
`;

const TASK_GET_PROMPT = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.
`;

const TASK_LIST_PROMPT = `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.
`;

const TASK_UPDATE_PROMPT = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`;

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
      taskId: { type: "string", description: "The ID of the task to retrieve" },
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
      taskId: { type: "string", description: "The ID of the task to update" },
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
