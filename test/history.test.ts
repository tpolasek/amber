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
    { ...base, id: "current", role: "assistant", content: "", status: "streaming" },
  ];

  assert.deepEqual(buildProviderHistory(messages, "current"), [
    { role: "user", content: "What is 9 + 9?" },
    { role: "assistant", content: "18" },
  ]);
});
