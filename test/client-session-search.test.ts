import test from "node:test";
import assert from "node:assert/strict";
import { findSessionText } from "../src/client-session-search.js";
import type { Message } from "../src/client-types.js";

const message = (id: string, content: string, thinking?: string): Message => ({
  id, role: "assistant", content, ...(thinking ? { thinking } : {}), createdAt: "2026-01-01T00:00:00.000Z", status: "complete",
});

test("finds the newest visible match without regard to case", () => {
  const messages = [message("old", "router test"), message("new", "The Router Test passed")];
  assert.deepEqual(findSessionText(messages, "router test"), { messageId: "new", field: "content" });
});

test("finds thinking and ignores hidden attachment messages", () => {
  const messages = [message("thinking", "no match", "router test"), {
    ...message("attachment", "router test"), kind: "tool-result" as const,
  }];
  assert.deepEqual(findSessionText(messages, "router test"), { messageId: "thinking", field: "thinking" });
});

test("returns null for missing or empty text", () => {
  assert.equal(findSessionText([message("one", "hello")], "router test"), null);
  assert.equal(findSessionText([message("one", "hello")], ""), null);
});
