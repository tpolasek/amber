import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeSystemPrompt,
  CLAUDE_CODE_TOOLS,
  injectClaudeCodeUserContext,
} from "../src/claude-code-compatibility.js";

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

test("advertises the seven Amber tools in Claude Code order", () => {
  assert.deepEqual(CLAUDE_CODE_TOOLS.map((tool) => tool.name), [
    "Agent",
    "Bash",
    "Edit",
    "Read",
    "TaskOutput",
    "TaskStop",
    "Write",
  ]);
  for (const tool of CLAUDE_CODE_TOOLS) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.input_schema.type, "object");
    assert.equal(tool.input_schema.additionalProperties, false);
  }
});
