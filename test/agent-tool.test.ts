import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentTool,
  getAgentDefinition,
  parseAgentInput,
  resolveAgentModel,
  startAgentRuns,
} from "../src/agent-tool.js";

const AGENTS = [
  { type: "general-purpose", whenToUse: "Handle general tasks.", systemPrompt: "Do the task.", readOnly: false },
  { type: "code-review", whenToUse: "Review code.", systemPrompt: "Review the code.", readOnly: true },
] as const;

test("uses the Claude Code Agent wire name and core input fields", () => {
  const agentTool = createAgentTool(AGENTS);
  assert.equal(agentTool.name, "Agent");
  assert.deepEqual(agentTool.input_schema.required, ["description", "prompt"]);
  assert.deepEqual(
    (agentTool.input_schema.properties.subagent_type as { enum?: string[] }).enum,
    ["general-purpose", "code-review"],
  );
  assert.deepEqual(Object.keys(agentTool.input_schema.properties), [
    "description",
    "prompt",
    "subagent_type",
    "model",
    "run_in_background",
  ]);
});

test("defaults Agent calls to general-purpose and accepts code-review", () => {
  assert.deepEqual(parseAgentInput({ description: "Trace the flow", prompt: "Inspect the request flow." }, AGENTS), {
    description: "Trace the flow",
    prompt: "Inspect the request flow.",
    subagentType: "general-purpose",
    runInBackground: false,
  });
  assert.equal(parseAgentInput({
    description: "Review latest diff",
    prompt: "Review git diff.",
    subagent_type: "code-review",
  }, AGENTS).subagentType, "code-review");
  assert.equal(getAgentDefinition(AGENTS, "code-review").readOnly, true);
});

test("supports custom configured agent types and defaults to the first", () => {
  const agents = [{ type: "research", whenToUse: "Research.", systemPrompt: "Research it.", readOnly: true }];
  assert.equal(parseAgentInput({ description: "Research issue", prompt: "Investigate." }, agents).subagentType, "research");
  assert.match(createAgentTool(agents).description, /research: Research\./);
});

test("resolves agent models by configured precedence", () => {
  assert.equal(resolveAgentModel("custom/model", "agent/default", "session/model", "app/default"), "custom/model");
  assert.equal(resolveAgentModel(undefined, "agent/default", "session/model", "app/default"), "agent/default");
  assert.equal(resolveAgentModel(undefined, undefined, "session/model", "app/default"), "session/model");
  assert.equal(resolveAgentModel(undefined, undefined, undefined, "app/default"), "app/default");
});

test("rejects unknown Agent types", () => {
  assert.throws(
    () => parseAgentInput({ description: "Do some work", prompt: "Work.", subagent_type: "explore" }, AGENTS),
    /Available agents: general-purpose, code-review/,
  );
});

test("starts every same-turn Agent call before awaiting results", async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const calls = [{ id: "agent-1" }, { id: "agent-2" }, { id: "agent-3" }];
  const runs = startAgentRuns(calls, async (call) => {
    started.push(call.id);
    await new Promise<void>((resolve) => releases.set(call.id, resolve));
    return `${call.id} complete`;
  });

  assert.deepEqual(started, ["agent-1", "agent-2", "agent-3"]);
  for (const call of calls) releases.get(call.id)!();
  assert.deepEqual(await Promise.all(calls.map((call) => runs.get(call.id))), [
    "agent-1 complete",
    "agent-2 complete",
    "agent-3 complete",
  ]);
});
