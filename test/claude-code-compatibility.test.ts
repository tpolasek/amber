import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeAgentSystemPrompt,
  buildClaudeCodeSystemPrompt,
  CLAUDE_CODE_AGENT_TOOLS,
  createClaudeCodeTools,
  injectClaudeCodeUserContext,
  structureClaudeCodeUserMessages,
} from "../src/claude-code-compatibility.js";
import { getAgentDefinition } from "../src/agent-tool.js";
import { SETTINGS_TEMPLATE } from "../src/settings.js";

const CLAUDE_CODE_TOOLS = createClaudeCodeTools(SETTINGS_TEMPLATE.agents);

test("builds the verified four-block Claude Code system prompt", () => {
  const system = buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5");
  assert.equal(system.length, 4);
  assert.equal(system[0]?.text, "x-anthropic-billing-header: cc_version=2.1.88.cfc; cc_entrypoint=sdk-cli;");
  assert.equal(system[1]?.text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.match(system[2]?.text ?? "", /^\nYou are an interactive agent that helps users with software engineering tasks\./);
  assert.match(system[3]?.text ?? "", /Primary working directory: \/tmp\/amber-not-a-repository/);
  assert.match(system[3]?.text ?? "", /Is a git repository: false/);
  assert.match(system[3]?.text ?? "", /You are powered by the model mimo-v2\.5\[1m\]\./);
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
  assert.equal(firstContent.length, 4);
  assert.match(firstContent[0]?.type === "text" ? firstContent[0].text : "", /SessionStart:startup hook success/);
  assert.match(firstContent[1]?.type === "text" ? firstContent[1].text : "", /The following skills are available/);
  assert.match(firstContent[2]?.type === "text" ? firstContent[2].text : "", /UserPromptSubmit hook success/);
  assert.deepEqual(firstContent[3], { type: "text", text: "4 + 4" });
  assert.equal(messages[2]?.content, "again");
});

test("advertises the twelve Amber tools in Claude Code order", () => {
  assert.deepEqual(CLAUDE_CODE_TOOLS.map((tool) => tool.name), [
    "Agent",
    "AskUserQuestion",
    "Bash",
    "Edit",
    "Read",
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
  assert.equal(system[0]?.text, "x-anthropic-billing-header: cc_version=2.1.88.516; cc_entrypoint=sdk-cli;");
  assert.equal(system[1]?.text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.equal(system.reduce((total, block) => total + block.text.length, 0), 2_308);
  assert.match(system[2]?.text ?? "", /Agent threads always have their cwd reset between bash calls/);
  assert.match(system[2]?.text ?? "", /Working directory: \/Users\/thomas\/code\/xude/);
  assert.match(system[2]?.text ?? "", /Is directory a git repo: Yes/);
});

test("structures an agent prompt as one text block and uses the shared child tools", () => {
  const messages = structureClaudeCodeUserMessages([{ role: "user", content: "Find the PID" }]);
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "Find the PID" }] }]);
  assert.deepEqual(CLAUDE_CODE_AGENT_TOOLS.map((tool) => tool.name), ["Bash", "Edit", "Read", "Write"]);
});
