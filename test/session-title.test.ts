import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_TITLE_PROMPT } from "../src/prompts.js";
import { generateSessionTitle, parseSessionTitle, shouldAutoNameSession } from "../src/session-title.js";
import type { LlmProvider, Message, ProviderMessage, StreamEvent } from "../src/types.js";

test("generates a session title without mutating or exposing UI-only history", async () => {
  const now = new Date().toISOString();
  const messages: Message[] = [
    { id: "user", role: "user", content: "The login button fails on phones", createdAt: now, status: "complete" },
    { id: "assistant", role: "assistant", content: "I found the CSS issue", createdAt: now, status: "complete" },
    { id: "banner", role: "assistant", content: "Forked from session: source", createdAt: now, status: "complete", kind: "fork-banner" },
  ];
  let receivedMessages: ProviderMessage[] = [];
  const provider: LlmProvider = {
    name: "Test",
    model: "test-model",
    mode: "live",
    async *stream(history: ProviderMessage[]): AsyncGenerator<StreamEvent> {
      receivedMessages = history;
      yield { type: "delta", text: '{"title":"Fix mobile login button"}' };
      yield { type: "done" };
    },
  };

  const title = await generateSessionTitle(provider, messages, new AbortController().signal);
  assert.equal(title, "Fix mobile login button");
  assert.deepEqual(receivedMessages, [
    { role: "user", content: "The login button fails on phones" },
    { role: "assistant", content: "I found the CSS issue" },
    { role: "user", content: SESSION_TITLE_PROMPT },
  ]);
  assert.equal(messages.length, 3);
});

test("parses fenced JSON and rejects invalid generated titles", () => {
  assert.equal(parseSessionTitle('```json\n{"title":"Debug failing CI tests"}\n```'), "Debug failing CI tests");
  assert.throws(() => parseSessionTitle("not json"), /invalid session title/);
  assert.throws(() => parseSessionTitle('{"title":""}'), /invalid session title/);
});

test("only auto-names an unset session before its first user message", () => {
  const now = new Date().toISOString();
  const unset = { id: "amber.session.id", title: "amber.session.id", messages: [] };
  assert.equal(shouldAutoNameSession(unset), true);
  assert.equal(shouldAutoNameSession({ ...unset, title: "Custom title" }), false);
  assert.equal(shouldAutoNameSession({
    ...unset,
    messages: [{ id: "user", role: "user", content: "Hello", createdAt: now, status: "complete" }],
  }), false);
  assert.equal(shouldAutoNameSession({
    ...unset,
    messages: [{
      id: "banner",
      role: "assistant",
      content: "Forked from another session",
      createdAt: now,
      status: "complete",
      kind: "fork-banner",
    }],
  }), true);
});
