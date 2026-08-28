import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeAgentSystemPrompt,
  buildClaudeCodeSystemPrompt,
  CLAUDE_CODE_AGENT_TOOLS,
  createClaudeCodeTools,
  injectClaudeCodeUserContext,
  structureClaudeCodeUserMessages,
  toolsForPlanMode,
} from "../src/claude-code-compatibility.js";
import { getAgentDefinition } from "../src/agent-tool.js";
import { SETTINGS_TEMPLATE } from "../src/settings.js";

const CLAUDE_CODE_TOOLS = createClaudeCodeTools(SETTINGS_TEMPLATE.agents);

test("builds the verified three-block Claude Code system prompt", () => {
  const system = buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5");
  assert.equal(system.length, 3);
  assert.equal(system[0]?.text, "You are a Amber agent.");
  assert.match(system[1]?.text ?? "", /^\nYou are an interactive agent that helps users with software engineering tasks\./);
  assert.deepEqual(system[1]?.cache_control, { scope: "global", type: "ephemeral" });
  assert.match(system[2]?.text ?? "", /Primary working directory: \/tmp\/amber-not-a-repository/);
  assert.match(system[2]?.text ?? "", /Is a git repository: false/);
  assert.match(system[2]?.text ?? "", /You are powered by the model mimo-v2\.5\./);
});

test("injects the verified reminders before only the first user prompt", () => {
  const messages = injectClaudeCodeUserContext([
    { role: "user", content: "4 + 4" },
    { role: "assistant", content: "8" },
    { role: "user", content: "again" },
  ]);
  assert.ok(Array.isArray(messages[0]?.content));
  const firstContent = messages[0]?.content;
  assert.ok(Array.isArray(firstContent));
  assert.equal(firstContent.length, 3);
  assert.match(firstContent[0]?.type === "text" ? firstContent[0].text : "", /The following skills are available/);
  assert.match(firstContent[1]?.type === "text" ? firstContent[1].text : "", /# currentDate/);
  assert.deepEqual(firstContent[2], { type: "text", text: "4 + 4" });
  assert.equal(messages[2]?.content, "again");

  const single = injectClaudeCodeUserContext([{ role: "user", content: "solo" }]);
  const singleContent = single[0]?.content;
  assert.ok(Array.isArray(singleContent));
  assert.deepEqual(singleContent.at(-1), { type: "text", text: "solo", cache_control: { type: "ephemeral" } });
});

test("advertises the fifteen Amber tools in Claude Code order", () => {
  assert.deepEqual(CLAUDE_CODE_TOOLS.map((tool) => tool.name), [
    "Agent",
    "AskUserQuestion",
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "Read",
    "Skill",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "TaskUpdate",
    "Write",
  ]);
  for (const tool of CLAUDE_CODE_TOOLS) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.input_schema.type, "object");
    assert.equal(tool.input_schema.additionalProperties, false);
  }
  assert.equal(createClaudeCodeTools([]).some((tool) => tool.name === "Agent"), false);
});

test("builds the verified three-block general agent prompt", () => {
  const system = buildClaudeCodeAgentSystemPrompt(
    "/Users/thomas/code/xude",
    "mimo-v2.5",
    getAgentDefinition(SETTINGS_TEMPLATE.agents, "general-purpose").systemPrompt,
  );
  assert.equal(system.length, 3);
  assert.equal(system[0]?.text, "x-anthropic-billing-header: cc_version=2.1.88.516; cc_entrypoint=cli;");
  assert.match(system[1]?.text ?? "", /^\nYou are an interactive agent that helps users with software engineering tasks\./);
  assert.deepEqual(system[1]?.cache_control, { type: "ephemeral" });
  assert.deepEqual(system[2]?.cache_control, { type: "ephemeral" });
  assert.ok(system.reduce((total, block) => total + block.text.length, 0) > 2_000);
  assert.match(system[2]?.text ?? "", /Agent threads always have their cwd reset between bash calls/);
  assert.match(system[2]?.text ?? "", /Working directory: \/Users\/thomas\/code\/xude/);
  assert.match(system[2]?.text ?? "", /Is directory a git repo: (?:Yes|No)/);
});

test("structures an agent prompt with the date reminder and uses the shared child tools", () => {
  const messages = structureClaudeCodeUserMessages([{ role: "user", content: "Find the PID" }]);
  const content = messages[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.match(content[0]?.type === "text" ? content[0].text : "", /# currentDate/);
  assert.deepEqual(content[1], { type: "text", text: "Find the PID", cache_control: { type: "ephemeral" } });

  const continued = structureClaudeCodeUserMessages([
    { role: "user", content: "Find the PID" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1234", is_error: false }] },
  ]);
  assert.equal(continued[0]?.content?.length, 2);
  assert.deepEqual(continued[0]?.content?.[1], { type: "text", text: "Find the PID" });
  assert.deepEqual(CLAUDE_CODE_AGENT_TOOLS.map((tool) => tool.name), [
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "Read",
    "Skill",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "Write",
  ]);
});

test("advertises exactly one browser plan control for the active mode", () => {
  const normal = toolsForPlanMode(CLAUDE_CODE_TOOLS, false);
  assert.equal(normal.at(-1)?.name, "EnterPlanMode");
  assert.equal(normal.some((tool) => tool.name === "ExitPlanMode"), false);

  const planning = toolsForPlanMode(CLAUDE_CODE_TOOLS, true);
  assert.equal(planning.at(-1)?.name, "ExitPlanMode");
  assert.equal(planning.some((tool) => tool.name === "EnterPlanMode"), false);

  const headless = toolsForPlanMode(CLAUDE_CODE_TOOLS, true, false);
  assert.deepEqual(headless.map((tool) => tool.name), CLAUDE_CODE_TOOLS.map((tool) => tool.name));
});
