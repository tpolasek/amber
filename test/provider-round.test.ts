import assert from "node:assert/strict";
import { test } from "node:test";
import { collectProviderRound } from "../src/provider-round.js";
import type { LlmProvider, Message, Session, StreamEvent } from "../src/types.js";

function fixture(events: StreamEvent[]) {
  const assistantMessage: Message = {
    id: "assistant-1",
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
  };
  const session: Session = {
    id: "fixture.session.id",
    title: "fixture",
    createdAt: assistantMessage.createdAt,
    updatedAt: assistantMessage.createdAt,
    messages: [assistantMessage],
  };
  const provider: LlmProvider = {
    name: "fixture",
    model: "fixture-model",
    protocol: "anthropic",
    mode: "live",
    async *stream() {
      for (const event of events) yield event;
    },
  };
  const emitted: string[] = [];
  let checkpoints = 0;
  let observedStopReason = "";
  const options = {
    provider,
    history: [],
    streamOptions: { tools: [] },
    signal: new AbortController().signal,
    session,
    assistantMessage,
    emit: (event: string) => emitted.push(event),
    checkpoint: async () => { checkpoints += 1; },
    onStopReason: (reason: string) => { observedStopReason = reason; },
  };
  return { assistantMessage, session, emitted, options, checkpoints: () => checkpoints, observedStopReason: () => observedStopReason };
}

test("collects provider text, usage, and parsed tool calls in stream order", async () => {
  const fx = fixture([
    { type: "delta", text: "Hello" },
    { type: "thinking_delta", thinking: "Consider" },
    { type: "thinking_signature_delta", signature: "sig" },
    { type: "tool_use_start", index: 0, id: "tool-1", name: "Glob" },
    { type: "tool_input_delta", index: 0, partialJson: '{"pattern":' },
    { type: "tool_input_delta", index: 0, partialJson: '"*.ts"}' },
    { type: "usage", usage: { input: 12, output: 3 } },
    { type: "done", stopReason: "tool_use" },
  ]);

  const round = await collectProviderRound(fx.options);

  assert.deepEqual(fx.emitted, ["delta", "thinking_delta", "tool_update"]);
  assert.equal(fx.checkpoints(), 3);
  assert.equal(fx.assistantMessage.content, "Hello");
  assert.equal(fx.assistantMessage.thinking, "Consider");
  assert.equal(fx.assistantMessage.thinkingSignature, "sig");
  assert.equal(fx.assistantMessage.status, "complete");
  assert.deepEqual(fx.assistantMessage.usage, { input: 12, output: 3 });
  assert.equal(fx.session.contextTokens, 15);
  assert.equal(round.stopReason, "tool_use");
  assert.equal(fx.observedStopReason(), "tool_use");
  assert.deepEqual(round.toolDrafts.get(0)?.call.input, { pattern: "*.ts" });
});

test("marks malformed tool input as a tool error", async () => {
  const fx = fixture([
    { type: "tool_use_start", index: 0, id: "tool-1", name: "Glob" },
    { type: "tool_input_delta", index: 0, partialJson: "[1]" },
  ]);

  const round = await collectProviderRound(fx.options);

  assert.equal(round.toolDrafts.get(0)?.call.status, "error");
  assert.match(round.toolDrafts.get(0)?.call.output ?? "", /Tool input must be an object/);
});
