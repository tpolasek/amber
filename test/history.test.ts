import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderHistory } from "../src/history.js";
import type { Message } from "../src/types.js";

test("provider history excludes commands, fork banners, streaming messages, and the current response", () => {
  const base = { createdAt: new Date().toISOString(), status: "complete" as const };
  const messages: Message[] = [
    { ...base, id: "user", role: "user", content: "What is 9 + 9?" },
    { ...base, id: "assistant", role: "assistant", content: "18" },
    { ...base, id: "command", role: "user", content: "/context", kind: "command" },
    { ...base, id: "banner", role: "assistant", content: "Forked from session: source", kind: "fork-banner", sourceSessionId: "source" },
    { ...base, id: "source-banner", role: "assistant", content: "Forked to session: fork", kind: "fork-banner", forkedSessionId: "fork" },
    { ...base, id: "compact-banner", role: "assistant", content: "Context compacted here", kind: "compact-banner" },
    { ...base, id: "current", role: "assistant", content: "", status: "streaming" },
  ];

  assert.deepEqual(buildProviderHistory(messages, "current"), [
    { role: "user", content: "What is 9 + 9?" },
    { role: "assistant", content: "18" },
  ]);
});

test("provider history uses the active summary and messages after the compaction boundary", () => {
  const base = { createdAt: new Date().toISOString(), status: "complete" as const };
  const messages: Message[] = [
    { ...base, id: "old-user", role: "user", content: "Implement the first version" },
    { ...base, id: "boundary", role: "assistant", content: "The first version is done" },
    { ...base, id: "banner", role: "assistant", content: "Context compacted here", kind: "compact-banner" },
    { ...base, id: "new-user", role: "user", content: "Now add tests" },
    { ...base, id: "current", role: "assistant", content: "", status: "streaming" },
  ];

  const history = buildProviderHistory(messages, "current", {
    summary: "The user requested the first version, which is complete.",
    throughMessageId: "boundary",
    createdAt: base.createdAt,
    coveredMessageCount: 2,
  });

  assert.equal(history.length, 2);
  assert.equal(history[0]?.role, "user");
  assert.equal(typeof history[0]?.content, "string");
  assert.match(history[0]?.content as string, /generated summary[\s\S]*first version, which is complete/);
  assert.deepEqual(history[1], { role: "user", content: "Now add tests" });
});

test("provider history safely falls back to raw messages when a compaction boundary is missing", () => {
  const message: Message = {
    id: "user", role: "user", content: "Keep the raw history", createdAt: new Date().toISOString(), status: "complete",
  };
  assert.deepEqual(buildProviderHistory([message], undefined, {
    summary: "Stale summary",
    throughMessageId: "missing",
    createdAt: message.createdAt,
    coveredMessageCount: 1,
  }), [{ role: "user", content: "Keep the raw history" }]);
});

test("provider history returns signed thinking blocks unchanged", () => {
  const message: Message = {
    id: "assistant",
    role: "assistant",
    content: "The answer is 42.",
    thinking: "Check the arithmetic carefully.",
    thinkingSignature: "opaque-provider-signature",
    createdAt: new Date().toISOString(),
    status: "complete",
  };

  assert.deepEqual(buildProviderHistory([message]), [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Check the arithmetic carefully.", signature: "opaque-provider-signature" },
      { type: "text", text: "The answer is 42." },
    ],
  }]);
});

test("provider history preserves tool calls and groups their results", () => {
  const now = new Date().toISOString();
  const messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      content: "I'll inspect both.",
      createdAt: now,
      status: "complete",
      toolCalls: [
        { id: "tool-1", name: "Bash", input: { command: "pwd" }, status: "complete", output: "/tmp" },
        { id: "tool-2", name: "Bash", input: { command: "false" }, status: "error", output: "" },
      ],
    },
    {
      id: "result-1", role: "user", content: "/tmp", createdAt: now, status: "complete",
      kind: "tool-result", toolUseId: "tool-1",
    },
    {
      id: "result-2", role: "user", content: "Exit code: 1", createdAt: now, status: "complete",
      kind: "tool-result", toolUseId: "tool-2", toolError: true,
    },
  ];

  assert.deepEqual(buildProviderHistory(messages), [
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect both." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "false" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "/tmp" },
        { type: "tool_result", tool_use_id: "tool-2", content: "Exit code: 1", is_error: true },
      ],
    },
  ]);
});
