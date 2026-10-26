// test/cli-display.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { SessionDisplay, type DisplayHooks, type DisplayOptions, type PlanDecision } from "../src/cli/display.js";
import { Terminal } from "../src/cli/term.js";
import type { Message } from "../src/types.js";

function harness(ask: (prompt: string) => Promise<string> = async () => "", options: DisplayOptions = {}) {
  const chunks: string[] = [];
  const out = { write: (chunk: string) => chunks.push(chunk), isTTY: false, columns: 60 };
  const term = new Terminal(out as never, 3_600_000, 1); // every append flushes
  const posted: unknown[] = [];
  const activeChanges: boolean[] = [];
  const hooks: DisplayHooks = {
    ask,
    answerQuestions: async (_session, _toolUseId, answers) => { posted.push(answers); },
    planDecision: async (_session, _toolUseId, decision: PlanDecision) => { posted.push(decision); },
    onActiveChange: (active) => activeChanges.push(active),
  };
  return {
    display: new SessionDisplay(term, "s1", hooks, options),
    text: () => chunks.join(""),
    posted: () => posted,
    activeChanges: () => activeChanges,
  };
}

function userMessage(id: string, content: string): Message {
  return { id, role: "user", content, createdAt: "", status: "complete" };
}

function assistant(id: string, content: string): Message {
  return { id, role: "assistant", content, createdAt: "", status: "complete" };
}

test("attach prints a dim user line and rendered assistant markdown", () => {
  const { display, text } = harness();
  display.attach([userMessage("u1", "hello there"), assistant("a1", "one\n\ntwo")], 2);
  assert.equal(text(), "\n> hello there\n\none\n\ntwo\n");
});

test("attach honors the limit", () => {
  const { display, text } = harness();
  display.attach([userMessage("u1", "old"), userMessage("u2", "new")], 1);
  assert.ok(!text().includes("old"));
  assert.ok(text().includes("new"));
});

test("start, delta blocks, and done print streamed blocks once with a usage line", async () => {
  const { display, text } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("delta", { text: "one\n\ntwo" });
  await display.applyEvent("delta", { text: " and more" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "one\n\ntwo and more"), usage: { input: 3_100, output: 800 } },
  });
  assert.equal(text(), "\none\n\ntwo and more\n\n· 3.1→0.8 tok\n");
});

test("done also prints the context and cache meters from the session snapshot", async () => {
  const { display, text } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("delta", { text: "answer" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "answer"), usage: { input: 31_000, output: 800, cached: 28_000 } },
    session: {
      id: "s1", title: "", createdAt: "", updatedAt: "", messages: [],
      recentCacheUsage: { input: 1_000, cached: 950, requests: 1 },
      cacheUsage: { input: 2_000, cached: 1_500, requests: 2 },
    },
  });
  assert.equal(
    text(),
    "\nanswer\n\n· 31→0.8 tok · CNTX 31.8k toks · CSH9 95% · CACH 75%\n",
  );
});

test("--thinking streams thinking lines before the answer", async () => {
  const { display, text } = harness(undefined, { streamThinking: true });
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("thinking_delta", { thinking: "consider " });
  await display.applyEvent("thinking_delta", { thinking: "this\nand that\n" });
  await display.applyEvent("delta", { text: "answer" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "answer"), usage: { input: 10, output: 2 } },
  });
  assert.equal(text(), "\n· thinking\nconsider this\nand that\n\nanswer\n\n· 0→0 tok\n");
});

test("thinking is only counted unless --thinking is set", async () => {
  const { display, text } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("thinking_delta", { thinking: "hidden\n" });
  await display.applyEvent("delta", { text: "answer" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "answer"), usage: { input: 10, output: 2 } },
  });
  assert.equal(text(), "\nanswer\n\n· 0→0 tok\n");
});

test("tool updates print one completion line and never output", async () => {
  const { display, text } = harness();
  await display.applyEvent("tool_update", {
    messageId: "a1",
    toolCall: { id: "t1", name: "Bash", input: { command: "npm test" }, status: "running", output: "" },
  });
  await display.applyEvent("tool_update", {
    messageId: "a1",
    toolCall: { id: "t1", name: "Bash", input: { command: "npm test" }, status: "complete", output: "HIDDEN OUTPUT", exitCode: 0, durationMs: 2_140 },
  });
  assert.equal(text(), "✓ Bash npm test · exit 0 · 2.1s\n");
  assert.equal(display.latestToolOutput(), "HIDDEN OUTPUT");
});

test("snapshot events print only unseen content", async () => {
  const { display, text } = harness();
  await display.applyEvent("snapshot", {
    session: { active: false, messages: [userMessage("u1", "hi"), assistant("a1", "para one\n\npara two")] },
  });
  const first = text();
  await display.applyEvent("snapshot", {
    session: { active: false, messages: [userMessage("u1", "hi"), assistant("a1", "para one\n\npara two")] },
  });
  assert.equal(text(), first);
});

test("ask_user_question prints numbered options and posts selected labels", async () => {
  const { display, text, posted } = harness(async () => "2");
  await display.applyEvent("ask_user_question", {
    toolUseId: "q1",
    questions: [{ question: "Pick one", header: "Pick", options: [{ label: "One" }, { label: "Two", description: "the second" }], multiSelect: false }],
  });
  assert.ok(text().includes("Pick: Pick one"));
  assert.ok(text().includes("  1) One"));
  assert.ok(text().includes("  2) Two — the second"));
  assert.deepEqual(posted(), [{ "Pick one": "Two" }]);
});

test("an empty gate answer declines the questions", async () => {
  const { display, posted } = harness(async () => "");
  await display.applyEvent("ask_user_question", {
    toolUseId: "q1",
    questions: [{ question: "Pick", options: [{ label: "One" }, { label: "Two" }], multiSelect: false }],
  });
  assert.deepEqual(posted(), [{ cancelled: true }]);
});

test("exit plan gate renders the plan and posts the decision", async () => {
  const { display, text, posted } = harness(async () => "s");
  await display.applyEvent("plan_mode_request", {
    toolUseId: "p1",
    kind: "exit",
    plan: "step one\n\nstep two",
    planFilePath: "/tmp/plan.md",
  });
  assert.ok(text().includes("step one"));
  assert.deepEqual(posted(), [{ newSession: true }]);
});

test("error events print one line and clear the active flag", async () => {
  const { display, text, activeChanges } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("error", { error: "provider exploded" });
  assert.ok(text().includes("✗ error: provider exploded\n"));
  assert.equal(activeChanges().at(-1), false);
});
