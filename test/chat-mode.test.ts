import test from "node:test";
import assert from "node:assert/strict";
import { BASH_TOOL } from "../src/bash-tool.js";
import {
  CHAT_MODE_SYSTEM_PROMPT,
  CHAT_MODE_TOOLS,
  chatModeSystemBlocks,
  parseChatModeToggleInput,
} from "../src/chat-mode.js";

test("chat mode exposes Bash as its only tool", () => {
  assert.equal(CHAT_MODE_TOOLS.length, 1);
  assert.equal(CHAT_MODE_TOOLS[0]?.name, BASH_TOOL.name);
});

test("chat mode system prompt is minimal", () => {
  assert.equal(CHAT_MODE_SYSTEM_PROMPT.length < 400, true);
  assert.match(CHAT_MODE_SYSTEM_PROMPT, /helpful assistant/);
  assert.doesNotMatch(CHAT_MODE_SYSTEM_PROMPT, /Environment|git repository|AGENTS\.md/);
  assert.deepEqual(chatModeSystemBlocks(), [{ type: "text", text: CHAT_MODE_SYSTEM_PROMPT }]);
});

test("strictly parses chat mode toggle input", () => {
  assert.deepEqual(parseChatModeToggleInput({ active: true }), { active: true });
  assert.deepEqual(parseChatModeToggleInput({ active: false }), { active: false });
  assert.throws(() => parseChatModeToggleInput({ active: "yes" }), /boolean/);
  assert.throws(() => parseChatModeToggleInput({ active: true, extra: true }), /unknown field/);
  assert.throws(() => parseChatModeToggleInput(null), /must be an object/);
});
