import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderSystemBlock, ToolDefinition } from "./types.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
export const MAX_PLAN_CHARACTERS = 100_000;

export const ENTER_PLAN_MODE_TOOL_PROMPT = `Request the user's approval to enter plan mode before a non-trivial implementation.

Use this when the work requires a meaningful architectural choice, has important unresolved requirements, or is broad or risky enough that the user should review the approach first. Do not use it for research-only requests, small fixes, or clear implementation work merely because it touches several files.

If approved, plan mode permits read-only exploration and restricts Write and Edit to a session-specific plan file. Explore the codebase, clarify material decisions with AskUserQuestion, write a concrete implementation plan, and call ExitPlanMode when it is ready for review.

EnterPlanMode must be the sole tool call in the response.`;

export const EXIT_PLAN_MODE_TOOL_PROMPT = `Submit the completed plan for user review and request approval to begin implementation.

Use this only while plan mode is active and after writing a complete, executable Markdown plan to the plan file identified by the plan-mode system reminder. Resolve material questions with AskUserQuestion before submitting. Do not use this for research-only work, and do not ask for plan approval in prose or with AskUserQuestion.

ExitPlanMode reads the plan file itself and must be the sole tool call in the response.`;

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
    properties: {},
    additionalProperties: false,
  },
};

export interface PlanModeDecision {
  approved: boolean;
  feedback?: string;
  cancelled?: boolean;
  newSession?: true;
  newSessionId?: string;
}

export interface PlanModeToggleInput {
  active: boolean;
}

export type PlanModeRequestKind = "enter" | "exit";

export function parseEnterPlanModeInput(input: Record<string, unknown>): Record<string, never> {
  if (Object.keys(input).length !== 0) throw new Error("EnterPlanMode accepts only an empty object");
  return {};
}

export function parseExitPlanModeInput(input: Record<string, unknown>): Record<string, never> {
  if (Object.keys(input).length !== 0) throw new Error("ExitPlanMode accepts only an empty object");
  return {};
}

export function parsePlanModeDecision(value: unknown): PlanModeDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan mode decision must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "approved" && key !== "feedback" && key !== "cancelled" && key !== "newSession")) {
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
  if (input.newSession !== undefined && input.newSession !== true) {
    throw new Error("newSession must be true when provided");
  }
  if (input.newSession === true) {
    if (input.approved !== true) throw new Error("A new-session decision must approve the plan");
    if (input.cancelled === true) throw new Error("A new-session decision cannot also be cancelled");
    if (input.feedback !== undefined) throw new Error("A new-session decision cannot include feedback");
  }
  const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
  if (feedback.length > 32_000) throw new Error("feedback must be 32,000 characters or fewer");
  return {
    approved: input.approved,
    ...(feedback ? { feedback } : {}),
    ...(input.cancelled === true ? { cancelled: true } : {}),
    ...(input.newSession === true ? { newSession: true } : {}),
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

export function formatExitPlanModeNewSessionResult(newSessionId: string): string {
  return `The user approved the plan and chose to implement it in a new linked session (${newSessionId}). Do not implement the plan in this session; end the turn.`;
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
    return this.decideParsed(sessionId, toolUseId, parsePlanModeDecision(value));
  }

  decideParsed(sessionId: string, toolUseId: string, decision: PlanModeDecision): PlanModeDecision {
    this.#get(sessionId, toolUseId);
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
