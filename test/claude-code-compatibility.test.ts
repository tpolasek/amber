import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeAgentSystemPrompt,
  buildClaudeCodeSystemPrompt,
  CLAUDE_CODE_AGENT_TOOLS,
  createClaudeCodeTools,
  injectClaudeCodeUserContext,
  structureClaudeCodeUserMessages,
  toolsForAgentMode,
  toolsForPlanMode,
} from "../src/claude-code-compatibility.js";
import { getAgentDefinition } from "../src/agent-tool.js";
import { BASH_TOOL } from "../src/bash-tool.js";
import { EDIT_TOOL, READ_TOOL, WRITE_TOOL } from "../src/file-tools.js";
import { GLOB_TOOL } from "../src/glob-tool.js";
import { GREP_TOOL } from "../src/grep-tool.js";
import { SETTINGS_TEMPLATE } from "../src/settings-template.js";
import { TASK_OUTPUT_TOOL, TASK_STOP_TOOL } from "../src/task-tools.js";

const CLAUDE_CODE_TOOLS = createClaudeCodeTools(SETTINGS_TEMPLATE.agents);

test("builds the three-block Amber system prompt", () => {
  const system = buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5");
  assert.equal(system.length, 3);
  assert.equal(system[0]?.text, "You are Amber, an interactive software-engineering agent.");
  assert.match(system[1]?.text ?? "", /^\n# Working with the user/);
  assert.doesNotMatch(system[1]?.text ?? "", /hooks|not limited by the context window|AskUserQuestion/);
  assert.deepEqual(system[1]?.cache_control, { scope: "global", type: "ephemeral" });
  assert.match(system[2]?.text ?? "", /Primary working directory: \/tmp\/amber-not-a-repository/);
  assert.match(system[2]?.text ?? "", /Is a git repository: false/);
  assert.match(system[2]?.text ?? "", /You are powered by the model mimo-v2\.5\./);
});

test("appends user instructions as a delimited final system block", () => {
  const system = buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5", "Prefer plain dashes.");
  assert.equal(system.length, 4);
  const instructions = system[3]?.text ?? "";
  assert.match(instructions, /# User instructions/);
  assert.match(instructions, /~\/\.amber\/AGENTS\.md/);
  assert.match(instructions, /<user-instructions>\nPrefer plain dashes\.\n<\/user-instructions>/);
  assert.equal(system[2]?.text.includes("Prefer plain dashes."), false);
  assert.deepEqual(system[3]?.cache_control, { type: "ephemeral" });
});

test("omits the user instructions block when there are none", () => {
  assert.equal(buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5").length, 3);
  assert.equal(buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5", "").length, 3);
});

test("appends project instructions after user instructions", () => {
  const system = buildClaudeCodeSystemPrompt(
    "/tmp/amber-not-a-repository",
    "mimo-v2.5",
    "Prefer plain dashes.",
    "Run npm test before finishing.",
  );
  assert.equal(system.length, 5);
  assert.match(system[3]?.text ?? "", /# User instructions/);
  const project = system[4]?.text ?? "";
  assert.match(project, /# Project instructions/);
  assert.match(project, /<project-instructions>\nRun npm test before finishing\.\n<\/project-instructions>/);
  assert.deepEqual(system[4]?.cache_control, { type: "ephemeral" });
});

test("appends project instructions on their own when there are no user instructions", () => {
  const system = buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5", undefined, "Run npm test.");
  assert.equal(system.length, 4);
  assert.match(system[3]?.text ?? "", /# Project instructions/);
  assert.doesNotMatch(system[3]?.text ?? "", /# User instructions/);
  assert.equal(buildClaudeCodeSystemPrompt("/tmp/amber-not-a-repository", "mimo-v2.5", undefined, "").length, 3);
});

test("injects the date reminder before only the first user prompt", () => {
  const messages = injectClaudeCodeUserContext([
    { role: "user", content: "4 + 4" },
    { role: "assistant", content: "8" },
    { role: "user", content: "again" },
  ]);
  assert.ok(Array.isArray(messages[0]?.content));
  const firstContent = messages[0]?.content;
  assert.ok(Array.isArray(firstContent));
  assert.equal(firstContent.length, 2);
  assert.match(firstContent[0]?.type === "text" ? firstContent[0].text : "", /Current date: \d{4}-\d{2}-\d{2}/);
  assert.deepEqual(firstContent[1], { type: "text", text: "4 + 4" });
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
  const implementationTools = [BASH_TOOL, EDIT_TOOL, GLOB_TOOL, GREP_TOOL, READ_TOOL];
  for (const tool of implementationTools) {
    assert.equal(CLAUDE_CODE_TOOLS.find((candidate) => candidate.name === tool.name), tool);
  }
  assert.equal(CLAUDE_CODE_TOOLS.find((tool) => tool.name === "TaskOutput"), TASK_OUTPUT_TOOL);
  assert.equal(CLAUDE_CODE_TOOLS.find((tool) => tool.name === "TaskStop"), TASK_STOP_TOOL);
  assert.equal(CLAUDE_CODE_TOOLS.find((tool) => tool.name === "Write"), WRITE_TOOL);
  assert.equal(createClaudeCodeTools([]).some((tool) => tool.name === "Agent"), false);
});

test("builds a dedicated general-agent prompt", () => {
  const system = buildClaudeCodeAgentSystemPrompt(
    "/Users/thomas/code/xude",
    "mimo-v2.5",
    getAgentDefinition(SETTINGS_TEMPLATE.agents, "general-purpose").systemPrompt,
  );
  assert.equal(system.length, 1);
  assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  assert.match(system[0]?.text ?? "", /specialized Amber subagent/);
  assert.match(system[0]?.text ?? "", /return a concise, evidence-based result to the parent agent/);
  assert.doesNotMatch(system[0]?.text ?? "", /Claude Code|AskUserQuestion|x-anthropic-billing-header/);
  assert.match(system[0]?.text ?? "", /Bash shell state, including cd, does not persist/);
  assert.match(system[0]?.text ?? "", /Working directory: \/Users\/thomas\/code\/xude/);
  assert.match(system[0]?.text ?? "", /Is directory a git repo: (?:Yes|No)/);
});

test("structures an agent prompt with the date reminder and uses the shared child tools", () => {
  const messages = structureClaudeCodeUserMessages([{ role: "user", content: "Find the PID" }]);
  const content = messages[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.match(content[0]?.type === "text" ? content[0].text : "", /Current date:/);
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

test("injects context into array-content user messages such as image turns", () => {
  const injected = injectClaudeCodeUserContext([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "What is this?" },
      ],
    },
  ], "<system-reminder>\nThe following skills are available\n</system-reminder>");
  const content = injected[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 4);
  assert.match(content[0]?.type === "text" ? content[0].text : "", /The following skills are available/);
  assert.match(content[1]?.type === "text" ? content[1].text : "", /Current date:/);
  assert.deepEqual(content[2], { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
  assert.deepEqual(content[3], { type: "text", text: "What is this?", cache_control: { type: "ephemeral" } });

  const structured = structureClaudeCodeUserMessages([
    {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
    },
    { role: "assistant", content: "A PNG file." },
  ]);
  const structuredContent = structured[0]?.content;
  assert.ok(Array.isArray(structuredContent));
  assert.equal(structuredContent.length, 2);
  assert.match(structuredContent[0]?.type === "text" ? structuredContent[0].text : "", /Current date:/);
  assert.deepEqual(structuredContent[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
});

test("keeps Skill available to read-only and planning agents", () => {
  assert.deepEqual(toolsForAgentMode(true).map((tool) => tool.name), [
    "Bash",
    "Glob",
    "Grep",
    "Read",
    "Skill",
  ]);
  assert.deepEqual(toolsForAgentMode(false), CLAUDE_CODE_AGENT_TOOLS);
  assert.notEqual(toolsForAgentMode(false), CLAUDE_CODE_AGENT_TOOLS);
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
