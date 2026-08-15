import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderSystemBlock, ToolDefinition } from "./types.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
export const MAX_PLAN_CHARACTERS = 100_000;

export const ENTER_PLAN_MODE_TOOL_PROMPT = `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
2. **Multiple Valid Approaches**: The task can be solved in several different ways
3. **Code Modifications**: Changes that affect existing behavior or structure
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
6. **Unclear Requirements**: You need to explore before understanding the full scope
7. **User Preferences Matter**: The implementation could reasonably go multiple ways

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Read, Bash, and Agent tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase

Amber requirement: EnterPlanMode must be the sole tool call in your response.
`;

export const EXIT_PLAN_MODE_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

Amber requirement: ExitPlanMode must be the sole tool call in your response. allowedPrompts are informational in Amber and do not grant Bash permissions.
`;

export const ENTER_PLAN_MODE_TOOL: ToolDefinition = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description: ENTER_PLAN_MODE_TOOL_PROMPT,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const EXIT_PLAN_MODE_TOOL: ToolDefinition = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: EXIT_PLAN_MODE_TOOL_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      allowedPrompts: {
        type: "array",
        description: "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands. Amber displays them informationally and does not create permission rules.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", enum: ["Bash"], description: "The tool this prompt applies to" },
            prompt: { type: "string", description: 'Semantic description of the action, e.g. "run tests", "install dependencies"' },
          },
          required: ["tool", "prompt"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

export interface AllowedPlanPrompt {
  tool: "Bash";
  prompt: string;
}

export interface ExitPlanModeInput {
  allowedPrompts: AllowedPlanPrompt[];
}

export interface PlanModeDecision {
  approved: boolean;
  feedback?: string;
  cancelled?: boolean;
}

export interface PlanModeToggleInput {
  active: boolean;
}

export type PlanModeRequestKind = "enter" | "exit";

export function parseEnterPlanModeInput(input: Record<string, unknown>): Record<string, never> {
  if (Object.keys(input).length !== 0) throw new Error("EnterPlanMode accepts only an empty object");
  return {};
}

export function parseExitPlanModeInput(input: Record<string, unknown>): ExitPlanModeInput {
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "allowedPrompts")) {
    throw new Error("ExitPlanMode accepts only the optional allowedPrompts field");
  }
  if (input.allowedPrompts === undefined) return { allowedPrompts: [] };
  if (!Array.isArray(input.allowedPrompts)) throw new Error("ExitPlanMode allowedPrompts must be an array");
  const allowedPrompts = input.allowedPrompts.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`ExitPlanMode allowedPrompts entry ${index + 1} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "tool" && key !== "prompt")) {
      throw new Error(`ExitPlanMode allowedPrompts entry ${index + 1} contains an unknown field`);
    }
    if (entry.tool !== "Bash") {
      throw new Error(`ExitPlanMode allowedPrompts entry ${index + 1} tool must be "Bash"`);
    }
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
      throw new Error(`ExitPlanMode allowedPrompts entry ${index + 1} prompt must be a non-empty string`);
    }
    return { tool: "Bash" as const, prompt: entry.prompt.trim() };
  });
  return { allowedPrompts };
}

export function parsePlanModeDecision(value: unknown): PlanModeDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan mode decision must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "approved" && key !== "feedback" && key !== "cancelled")) {
    throw new Error("Plan mode decision contains an unknown field");
  }
  if (typeof input.approved !== "boolean") throw new Error("approved must be a boolean");
  if (input.feedback !== undefined && typeof input.feedback !== "string") {
    throw new Error("feedback must be a string");
  }
  if (input.cancelled !== undefined && typeof input.cancelled !== "boolean") {
    throw new Error("cancelled must be a boolean");
  }
  if (input.approved === true && input.cancelled === true) {
    throw new Error("An approved plan mode decision cannot also be cancelled");
  }
  const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
  if (feedback.length > 32_000) throw new Error("feedback must be 32,000 characters or fewer");
  return {
    approved: input.approved,
    ...(feedback ? { feedback } : {}),
    ...(input.cancelled === true ? { cancelled: true } : {}),
  };
}

export function parsePlanModeToggleInput(value: unknown): PlanModeToggleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan mode selection must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "active")) {
    throw new Error("Plan mode selection contains an unknown field");
  }
  if (typeof input.active !== "boolean") throw new Error("active must be a boolean");
  return { active: input.active };
}

export function planFilePath(planDirectory: string, sessionId: string): string {
  return join(planDirectory, `${sessionId}.md`);
}

export async function ensurePlanFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readPlanSnapshot(filePath: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Plan file is missing: ${filePath}. Write the plan before calling ExitPlanMode.`);
    }
    throw error;
  }
  if (!contents.trim()) throw new Error(`Plan file is blank: ${filePath}. Write the plan before calling ExitPlanMode.`);
  if (contents.length > MAX_PLAN_CHARACTERS) {
    throw new Error(`Plan exceeds the ${MAX_PLAN_CHARACTERS.toLocaleString()}-character review limit`);
  }
  return contents;
}

export function formatEnterPlanModeResult(planPath: string): string {
  return `Plan mode is active. Explore and clarify before implementation, and write the complete plan to ${planPath}. Finish by calling ExitPlanMode as the sole tool call.`;
}

export function formatEnterPlanModeDeclinedResult(): string {
  return "The user declined plan mode. Stop now and do not continue this turn or attempt implementation.";
}

export function formatExitPlanModeApprovedResult(plan: string): string {
  return `The user approved the following reviewed plan. Plan mode is now inactive; proceed directly with implementation.\n\n${plan}`;
}

export function formatExitPlanModeRejectedResult(feedback?: string): string {
  return feedback
    ? `The user chose to keep planning and provided this feedback:\n\n${feedback}\n\nRevise the plan file and call ExitPlanMode again when it is ready.`
    : "The user chose to keep planning. Revise the plan file as needed and call ExitPlanMode again when it is ready.";
}

export function formatExitPlanModeCancelledResult(): string {
  return "The user closed the plan review without exiting plan mode. Stop now and wait for the user to send another prompt.";
}

export function planModeSystemBlock(planPath: string, childAgent = false): ProviderSystemBlock {
  const access = childAgent
    ? [
        "You are a planning subagent. You have only Read and Bash tools and must not modify files or system state.",
        "Return exploration findings to the parent agent; do not attempt to enter or exit plan mode.",
      ]
    : [
        `The only file you may modify with Write or Edit is the plan file: ${planPath}`,
        "Do not modify source files, configuration, generated artifacts, or other project state. Bash must be used only for read-only exploration.",
        "Use Read, read-only Bash, and Agent exploration to understand the codebase. Use AskUserQuestion only when requirements or meaningful tradeoffs need clarification.",
        "Write a specific, executable Markdown plan to the plan file. Preserve and improve an existing plan when re-entering plan mode instead of discarding useful work.",
        "When the plan is complete, call ExitPlanMode as the sole tool call. Do not ask for plan approval in prose or through AskUserQuestion.",
      ];
  return {
    type: "text",
    text: [
      "<system-reminder>",
      "Plan mode is active. The user has not authorized implementation.",
      `Plan file: ${planPath}`,
      ...access,
      "</system-reminder>",
    ].join("\n"),
  };
}

interface PendingPlanModeRequest {
  toolUseId: string;
  kind: PlanModeRequestKind;
  resolve: (decision: PlanModeDecision) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class PlanModeApprovalManager {
  #pending = new Map<string, PendingPlanModeRequest>();

  pending(sessionId: string): { toolUseId: string; kind: PlanModeRequestKind } | undefined {
    const pending = this.#pending.get(sessionId);
    if (!pending) return undefined;
    return { toolUseId: pending.toolUseId, kind: pending.kind };
  }

  waitForDecision(
    sessionId: string,
    toolUseId: string,
    kind: PlanModeRequestKind,
    signal: AbortSignal,
  ): Promise<PlanModeDecision> {
    if (this.#pending.has(sessionId)) throw new Error("This session already has a pending plan mode request");
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#settle(sessionId, toolUseId, undefined, abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(sessionId, {
        toolUseId,
        kind,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      });
    });
  }

  decide(sessionId: string, toolUseId: string, value: unknown): PlanModeDecision {
    const pending = this.#get(sessionId, toolUseId);
    const decision = parsePlanModeDecision(value);
    this.#settle(sessionId, toolUseId, decision);
    return decision;
  }

  stopAll(): void {
    for (const [sessionId, pending] of this.#pending) {
      this.#settle(sessionId, pending.toolUseId, undefined, abortError());
    }
  }

  pendingKind(sessionId: string, toolUseId: string): PlanModeRequestKind {
    return this.#get(sessionId, toolUseId).kind;
  }

  #get(sessionId: string, toolUseId: string): PendingPlanModeRequest {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) throw new Error("Plan mode request is no longer pending");
    return pending;
  }

  #settle(sessionId: string, toolUseId: string, decision?: PlanModeDecision, error?: Error): void {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) return;
    this.#pending.delete(sessionId);
    pending.removeAbortListener();
    if (error) pending.reject(error);
    else pending.resolve(decision ?? { approved: false });
  }
}

function abortError(): Error {
  const error = new Error("Plan mode request aborted");
  error.name = "AbortError";
  return error;
}
