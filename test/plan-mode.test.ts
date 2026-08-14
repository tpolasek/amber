import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
  MAX_PLAN_CHARACTERS,
  PlanModeApprovalManager,
  formatExitPlanModeApprovedResult,
  formatExitPlanModeCancelledResult,
  formatExitPlanModeRejectedResult,
  parseEnterPlanModeInput,
  parseExitPlanModeInput,
  parsePlanModeDecision,
  parsePlanModeToggleInput,
  planFilePath,
  planModeSystemBlock,
  readPlanSnapshot,
} from "../src/plan-mode.js";

test("defines strict Claude-compatible plan mode tool contracts", () => {
  assert.equal(ENTER_PLAN_MODE_TOOL.name, "EnterPlanMode");
  assert.deepEqual(ENTER_PLAN_MODE_TOOL.input_schema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.equal(EXIT_PLAN_MODE_TOOL.name, "ExitPlanMode");
  assert.deepEqual(EXIT_PLAN_MODE_TOOL.input_schema.required, undefined);
  assert.equal(EXIT_PLAN_MODE_TOOL.input_schema.additionalProperties, false);
  const allowedPrompts = EXIT_PLAN_MODE_TOOL.input_schema.properties.allowedPrompts as {
    items: { required: string[]; additionalProperties: boolean; properties: { tool: { enum: string[] } } };
  };
  assert.deepEqual(allowedPrompts.items.required, ["tool", "prompt"]);
  assert.deepEqual(allowedPrompts.items.properties.tool.enum, ["Bash"]);
  assert.equal(allowedPrompts.items.additionalProperties, false);
  assert.match(EXIT_PLAN_MODE_TOOL.description, /informational/);
});

test("strictly parses entry and optional exit allowed prompts", () => {
  assert.deepEqual(parseEnterPlanModeInput({}), {});
  assert.throws(() => parseEnterPlanModeInput({ unexpected: true }), /empty object/);
  assert.deepEqual(parseExitPlanModeInput({}), { allowedPrompts: [] });
  assert.deepEqual(parseExitPlanModeInput({
    allowedPrompts: [{ tool: "Bash", prompt: "Run unit tests" }],
  }), { allowedPrompts: [{ tool: "Bash", prompt: "Run unit tests" }] });
  assert.throws(() => parseExitPlanModeInput({ extra: true }), /only the optional/);
  assert.throws(() => parseExitPlanModeInput({ allowedPrompts: [{ tool: "Write", prompt: "Change files" }] }), /must be "Bash"/);
  assert.throws(() => parseExitPlanModeInput({ allowedPrompts: [{ tool: "Bash", prompt: "" }] }), /non-empty/);
  assert.throws(() => parseExitPlanModeInput({ allowedPrompts: [{ tool: "Bash", prompt: "Test", extra: true }] }), /unknown field/);
  assert.throws(() => parsePlanModeDecision({ approved: true, extra: true }), /unknown field/);
  assert.deepEqual(parsePlanModeDecision({ approved: false, cancelled: true }), {
    approved: false,
    cancelled: true,
  });
  assert.throws(() => parsePlanModeDecision({ approved: true, cancelled: true }), /cannot also be cancelled/);
  assert.deepEqual(parsePlanModeToggleInput({ active: true }), { active: true });
  assert.deepEqual(parsePlanModeToggleInput({ active: false }), { active: false });
  assert.throws(() => parsePlanModeToggleInput({ active: "yes" }), /boolean/);
  assert.throws(() => parsePlanModeToggleInput({ active: true, extra: true }), /unknown field/);
});

test("validates a bounded, nonblank plan snapshot before review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-plan-"));
  const path = planFilePath(directory, "quiet.river.stone");
  await assert.rejects(readPlanSnapshot(path), /missing/);
  await writeFile(path, "  \n", "utf8");
  await assert.rejects(readPlanSnapshot(path), /blank/);
  await writeFile(path, "# Plan\n\n- Implement it\n", "utf8");
  assert.equal(await readPlanSnapshot(path), "# Plan\n\n- Implement it\n");
  await writeFile(path, "x".repeat(MAX_PLAN_CHARACTERS + 1), "utf8");
  await assert.rejects(readPlanSnapshot(path), /review limit/);
});

test("injects the exact plan path and planning boundaries", () => {
  const path = "/tmp/amber/plans/quiet.river.stone.md";
  const root = planModeSystemBlock(path);
  assert.match(root.text, new RegExp(path.replaceAll("/", "\\/")));
  assert.match(root.text, /only file you may modify/);
  assert.match(root.text, /Bash must be used only for read-only exploration/);
  assert.match(root.text, /ExitPlanMode as the sole tool call/);
  const child = planModeSystemBlock(path, true);
  assert.match(child.text, /only Read and Bash/);
  assert.match(child.text, /must not modify files/);
});

test("holds one matching approval request per session and retains rejection feedback", async () => {
  const manager = new PlanModeApprovalManager();
  const controller = new AbortController();
  const pending = manager.waitForDecision("session", "tool-1", "enter", controller.signal);
  assert.equal(manager.pendingKind("session", "tool-1"), "enter");
  assert.throws(() => manager.waitForDecision("session", "tool-2", "exit", controller.signal), /already has/);
  assert.throws(() => manager.decide("session", "stale", { approved: true }), /no longer pending/);
  assert.deepEqual(manager.decide("session", "tool-1", { approved: true }), { approved: true });
  assert.deepEqual(await pending, { approved: true });

  const rejected = manager.waitForDecision("session", "tool-2", "exit", controller.signal);
  manager.decide("session", "tool-2", { approved: false, feedback: "  Add rollback steps.  " });
  assert.deepEqual(await rejected, { approved: false, feedback: "Add rollback steps." });
  assert.match(formatExitPlanModeRejectedResult("Add rollback steps."), /Add rollback steps/);
  assert.match(formatExitPlanModeApprovedResult("# Reviewed"), /# Reviewed/);
  assert.match(formatExitPlanModeCancelledResult(), /Stop now and wait/);
});

test("cleans up pending plan approvals when a run aborts or the manager stops", async () => {
  const manager = new PlanModeApprovalManager();
  const controller = new AbortController();
  const aborted = manager.waitForDecision("first", "tool-1", "enter", controller.signal);
  controller.abort();
  await assert.rejects(aborted, (error: Error) => error.name === "AbortError");

  const stopped = manager.waitForDecision("second", "tool-2", "exit", new AbortController().signal);
  manager.stopAll();
  await assert.rejects(stopped, (error: Error) => error.name === "AbortError");
});
