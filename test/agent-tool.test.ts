import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_TOOL, getAgentDefinition, parseAgentInput } from "../src/agent-tool.js";

test("uses the Claude Code Agent wire name and core input fields", () => {
  assert.equal(AGENT_TOOL.name, "Agent");
  assert.deepEqual(AGENT_TOOL.input_schema.required, ["description", "prompt"]);
  assert.deepEqual(Object.keys(AGENT_TOOL.input_schema.properties), [
    "description",
    "prompt",
    "subagent_type",
    "model",
    "run_in_background",
  ]);
});

test("defaults Agent calls to general-purpose and accepts code-review", () => {
  assert.deepEqual(parseAgentInput({ description: "Trace the flow", prompt: "Inspect the request flow." }), {
    description: "Trace the flow",
    prompt: "Inspect the request flow.",
    subagentType: "general-purpose",
    runInBackground: false,
  });
  assert.equal(parseAgentInput({
    description: "Review latest diff",
    prompt: "Review git diff.",
    subagent_type: "code-review",
  }).subagentType, "code-review");
  assert.equal(getAgentDefinition("code-review").readOnly, true);
});

test("rejects unknown Agent types", () => {
  assert.throws(
    () => parseAgentInput({ description: "Do some work", prompt: "Work.", subagent_type: "explore" }),
    /Available agents: general-purpose, code-review/,
  );
});
