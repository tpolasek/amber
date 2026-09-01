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

test("provider history excludes tool results already included in a compaction summary", () => {
  const now = new Date().toISOString();
  const messages: Message[] = [
    { id: "user", role: "user", content: "Write the file", createdAt: now, status: "complete" },
    {
      id: "boundary",
      role: "assistant",
      content: "",
      createdAt: now,
      status: "complete",
      toolCalls: [{ id: "write-call", name: "Write", input: { file_path: "/tmp/file" }, status: "complete", output: "" }],
    },
    {
      id: "result",
      role: "user",
      content: "File written",
      createdAt: now,
      status: "complete",
      kind: "tool-result",
      toolUseId: "write-call",
    },
    { id: "banner", role: "assistant", content: "Context compacted here", createdAt: now, status: "complete", kind: "compact-banner" },
    { id: "continue", role: "user", content: "Continue", createdAt: now, status: "complete" },
  ];

  const history = buildProviderHistory(messages, undefined, {
    summary: "The file was written.",
    throughMessageId: "boundary",
    createdAt: now,
    coveredMessageCount: 2,
  });

  assert.equal(history.length, 2);
  assert.match(history[0]?.content as string, /The file was written/);
  assert.deepEqual(history[1], { role: "user", content: "Continue" });
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
      id: "result-2", role: "user", content: "Exit code 1", createdAt: now, status: "complete",
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
        { type: "tool_result", tool_use_id: "tool-1", content: "/tmp", is_error: false },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "Exit code 1",
          is_error: true,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("provider history emits agent results as text blocks without is_error", () => {
  const now = new Date().toISOString();
  const blocks = [
    { type: "text" as const, text: "USA has the highest GDP." },
    {
      type: "text" as const,
      text: "agentId: warm-oak-idea.k3m9x2q1 (use SendMessage with to: 'warm-oak-idea.k3m9x2q1' to continue this agent)\n"
        + "<usage>total_tokens: 7546\ntool_uses: 1\nduration_ms: 5614</usage>",
    },
  ];
  const messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      content: "",
      createdAt: now,
      status: "complete",
      toolCalls: [{ id: "agent-1", name: "Agent", input: {}, status: "complete", output: "" }],
    },
    {
      id: "result",
      role: "user",
      content: "USA has the highest GDP.",
      createdAt: now,
      status: "complete",
      kind: "tool-result",
      toolUseId: "agent-1",
      contentBlocks: blocks,
    },
  ];

  const history = buildProviderHistory(messages);
  const toolResult = (history[1]?.content as Array<Record<string, unknown>>)?.[0];
  assert.deepEqual(toolResult, {
    type: "tool_result",
    tool_use_id: "agent-1",
    content: blocks,
    cache_control: { type: "ephemeral" },
  });
});

test("provider history merges an injected skill message into the tool-result user turn", () => {
  const now = new Date().toISOString();
  const messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      content: "Loading the skill.",
      createdAt: now,
      status: "complete",
      toolCalls: [{ id: "skill-1", name: "Skill", input: { skill: "commit" }, status: "complete", output: "" }],
    },
    {
      id: "result",
      role: "user",
      content: "Launching skill: commit",
      createdAt: now,
      status: "complete",
      kind: "tool-result",
      toolUseId: "skill-1",
    },
    {
      id: "expanded",
      role: "user",
      content: "<command-name>/commit</command-name>\n\nCreate a commit.",
      createdAt: now,
      status: "complete",
      kind: "skill",
      skillName: "commit",
    },
  ];

  assert.deepEqual(buildProviderHistory(messages), [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Loading the skill." },
        { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "commit" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "skill-1", content: "Launching skill: commit", is_error: false },
        {
          type: "text",
          text: "<command-name>/commit</command-name>\n\nCreate a commit.",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("provider history includes a hidden background-agent notification with the next user turn", () => {
  const now = new Date().toISOString();
  const messages: Message[] = [
    { id: "user", role: "user", content: "Continue the work", createdAt: now, status: "complete" },
    {
      id: "notification",
      role: "user",
      content: "<task-notification>Agent result</task-notification>",
      createdAt: now,
      status: "complete",
      kind: "agent-notification",
    },
  ];

  assert.deepEqual(buildProviderHistory(messages), [{
    role: "user",
    content: [
      { type: "text", text: "Continue the work" },
      {
        type: "text",
        text: "<task-notification>Agent result</task-notification>",
        cache_control: { type: "ephemeral" },
      },
    ],
  }]);
});

test("provider history emits user images before the text block", () => {
  const now = new Date().toISOString();
  const image = { mediaType: "image/png" as const, data: "aGVsbG8=" };
  const messages: Message[] = [
    { id: "user", role: "user", content: "What is in this picture?", createdAt: now, status: "complete", images: [image] },
  ];

  assert.deepEqual(buildProviderHistory(messages), [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      { type: "text", text: "What is in this picture?", cache_control: { type: "ephemeral" } },
    ],
  }]);

  const imageOnly: Message[] = [
    { id: "user", role: "user", content: "", createdAt: now, status: "complete", images: [image] },
  ];
  assert.deepEqual(buildProviderHistory(imageOnly), [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }, cache_control: { type: "ephemeral" } },
    ],
  }]);
});

test("provider history attaches image reads to tool results", () => {
  const now = new Date().toISOString();
  const image = { mediaType: "image/png" as const, data: "aGVsbG8=" };
  const messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      content: "",
      createdAt: now,
      status: "complete",
      toolCalls: [{ id: "read-1", name: "Read", input: { file_path: "/tmp/pic.png" }, status: "complete", output: "" }],
    },
    {
      id: "result",
      role: "user",
      content: "Read /tmp/pic.png: image/png image attached to this tool result.",
      createdAt: now,
      status: "complete",
      kind: "tool-result",
      toolUseId: "read-1",
      images: [image],
    },
  ];

  assert.deepEqual(buildProviderHistory(messages)[1], {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "read-1",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "Read /tmp/pic.png: image/png image attached to this tool result." },
      ],
      is_error: false,
      cache_control: { type: "ephemeral" },
    }],
  });
});

test("provider history reinjects compacted skill instructions without duplicating active ones", () => {
  const now = new Date().toISOString();
  const base = { createdAt: now, status: "complete" as const };
  const compaction = { summary: "Earlier work.", throughMessageId: "boundary", createdAt: now, coveredMessageCount: 2 };
  const messages: Message[] = [
    { ...base, id: "old-user", role: "user", content: "Use both skills" },
    { ...base, id: "boundary", role: "assistant", content: "Done with both" },
    { ...base, id: "new-user", role: "user", content: "Continue" },
  ];
  const invoked = [
    { name: "gone", path: "/tmp/gone/SKILL.md", content: "Gone skill body", invokedAt: now },
    { name: "active", path: "/tmp/active/SKILL.md", content: "Active skill body", invokedAt: now },
  ];

  const withoutActive = buildProviderHistory(messages, undefined, compaction, invoked);
  const first = withoutActive[0]?.content;
  assert.ok(Array.isArray(first));
  assert.match(first[0]?.type === "text" ? first[0].text : "", /generated summary/);
  assert.match(first[1]?.type === "text" ? first[1].text : "", /remain in effect[\s\S]*Gone skill body/);

  const withActive: Message[] = [
    ...messages,
    { ...base, id: "skill-message", role: "user", content: "Active skill body", kind: "skill", skillName: "active" },
  ];
  const deduped = buildProviderHistory(withActive, undefined, compaction, invoked);
  const reinjection = deduped[0]?.content;
  assert.ok(Array.isArray(reinjection));
  assert.match(reinjection[1]?.type === "text" ? reinjection[1].text : "", /Gone skill body/);
  assert.equal(reinjection[1]?.type === "text" ? reinjection[1].text.includes("Active skill body") : true, false);
  const activeTurn = deduped.find((message) => message.role === "user" && Array.isArray(message.content)
    && message.content.some((block) => block.type === "text" && block.text === "Active skill body"));
  assert.ok(activeTurn);
});
