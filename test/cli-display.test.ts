// test/cli-display.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { SessionDisplay, type DisplayHooks, type DisplayOptions, type PlanDecision } from "../src/cli/display.js";
import { Terminal } from "../src/cli/term.js";
import type { Message } from "../src/types.js";
import { displayWidth } from "../src/cli/render.js";
import { DARK } from "../src/cli/theme.js";

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

/** The status line only paints on an interactive terminal. */
function ttyHarness(options: DisplayOptions = {}) {
  const chunks: string[] = [];
  const out = { write: (chunk: string) => chunks.push(chunk), isTTY: true, columns: 60 };
  const term = new Terminal(out as never, 3_600_000, 1);
  const hooks: DisplayHooks = {
    ask: async () => "",
    answerQuestions: async () => undefined,
    planDecision: async () => undefined,
    onActiveChange: () => undefined,
  };
  return { display: new SessionDisplay(term, "s1", hooks, options), text: () => chunks.join("") };
}

function assistant(id: string, content: string): Message {
  return { id, role: "assistant", content, createdAt: "", status: "complete" };
}

/** Strips SGR codes and line-clears so styled output can be matched as text. */
function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[mK]/g, "");
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

test("start, delta blocks, and done print streamed blocks once", async () => {
  const { display, text } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("delta", { text: "one\n\ntwo" });
  await display.applyEvent("delta", { text: " and more" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "one\n\ntwo and more"), usage: { input: 3_100, output: 800 } },
  });
  assert.equal(text(), "\none\n\ntwo and more\n");
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
    "\nanswer\n\nCNTX 31.8k toks · CSH9 95% · CACH 75%\n",
  );
});

test("the meter footer's subtle fill hugs the meters plus a margin", async () => {
  const { display, text } = ttyHarness();
  await display.applyEvent("done", {
    message: assistant("a1", "answer"),
    session: {
      id: "s1", title: "", createdAt: "", updatedAt: "", messages: [],
      recentCacheUsage: { input: 1_000, cached: 950, requests: 1 },
      cacheUsage: { input: 2_000, cached: 1_500, requests: 2 },
    },
  });
  const line = text().trimEnd().split("\n").at(-1)!;
  assert.ok(line.startsWith(`\x1b[${DARK.accent};${DARK.meterFill}mCNTX`), line);
  assert.ok(line.endsWith("\x1b[0m"));
  const visibleText = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(displayWidth(visibleText), Math.min(60, displayWidth(visibleText.trimEnd()) + 3));
});

test("done without a message (standalone /compact) clears the active state without crashing", async () => {
  const { display, activeChanges } = harness();
  await display.applyEvent("compaction_start", {});
  await display.applyEvent("done", { session: { id: "s1", title: "", createdAt: "", updatedAt: "", messages: [] } });
  assert.equal(display.active, false);
  assert.deepEqual(activeChanges(), [true, false]);
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
  assert.equal(text(), "\n· thinking\nconsider this\nand that\n\nanswer\n");
});

test("thinking is only counted unless --thinking is set", async () => {
  const { display, text } = harness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", ""), userMessage: userMessage("u1", "prompt") });
  await display.applyEvent("thinking_delta", { thinking: "hidden\n" });
  await display.applyEvent("delta", { text: "answer" });
  await display.applyEvent("done", {
    message: { ...assistant("a1", "answer"), usage: { input: 10, output: 2 } },
  });
  assert.equal(text(), "\nanswer\n");
});

test("--thinking drops the char counter from the status line", async () => {
  const { display, text } = ttyHarness({ streamThinking: true });
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("thinking_delta", { thinking: "deep thought\n" });
  assert.ok(text().includes("deep thought"));
  assert.ok(!visible(text()).includes("thinking 12"));
});

test("the char counter still shows without --thinking", async () => {
  const { display, text } = ttyHarness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("thinking_delta", { thinking: "hidden\n" });
  assert.ok(visible(text()).includes("thinking 7"));
  assert.ok(!text().includes("hidden"));
});

test("idle work shows as a filled busy pill", async () => {
  const { display, text } = ttyHarness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("delta", { text: "" }); // paints the status with nothing counted yet
  assert.ok(text().includes(`\x1b[${DARK.statusActive}m working… \x1b[0m`));
});

test("streaming status pills the state word and accents the counter", async () => {
  const { display, text } = ttyHarness();
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("delta", { text: "abc" });
  const status = text().split("\r\x1b[K").pop()!;
  assert.equal(
    status,
    `\x1b[${DARK.statusActive}m streaming \x1b[0m\x1b[${DARK.accent}m3\x1b[0m`,
  );
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

test("--full prints the edit diff under the tool line", async () => {
  const { display, text } = harness(undefined, { full: true });
  await display.applyEvent("tool_update", {
    messageId: "a1",
    toolCall: {
      id: "t1",
      name: "Edit",
      input: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
      status: "complete",
      output: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      durationMs: 12,
    },
  });
  assert.ok(text().startsWith("✓ Edit src/x.ts"));
  assert.ok(text().includes("\n  @@ -1 +1 @@\n  -a\n  +b\n"));
});

test("edit diffs stay hidden without --full", async () => {
  const { display, text } = harness();
  await display.applyEvent("tool_update", {
    messageId: "a1",
    toolCall: {
      id: "t1",
      name: "Edit",
      input: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
      status: "complete",
      output: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      durationMs: 12,
    },
  });
  assert.ok(text().startsWith("✓ Edit src/x.ts"));
  assert.ok(!text().includes("+b"));
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

test("--thinking shades each line with a fill that hugs the text plus a margin", async () => {
  const { display, text } = ttyHarness({ streamThinking: true });
  await display.applyEvent("start", { assistantMessage: assistant("a1", "") });
  await display.applyEvent("thinking_delta", { thinking: "deep thought\n" });
  const lines = text().split("\n").filter((line) => /^\x1b\[[0-9;]+m/.test(line));
  assert.equal(lines.length, 2); // header + one body line
  for (const line of lines) {
    assert.ok(line.startsWith(`\x1b[${line.includes("· thinking") ? DARK.thinkingHeader : DARK.thinking}m`), line);
    assert.ok(line.endsWith("\x1b[0m"));
    const visibleText = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(displayWidth(visibleText), Math.min(60, displayWidth(visibleText.trimEnd()) + 3));
  }
});

test("tool lines color the glyph, name, argument, and tail separately", async () => {
  const { display, text } = ttyHarness();
  await display.applyEvent("tool_update", {
    messageId: "a1",
    toolCall: { id: "t1", name: "Bash", input: { command: "npm test" }, status: "complete", output: "", exitCode: 0, durationMs: 2_140 },
  });
  const line = text().trimEnd();
  assert.equal(
    line,
    `\x1b[${DARK.toolOk}m✓\x1b[0m\x1b[${DARK.toolName}m Bash\x1b[0m\x1b[${DARK.toolArg}m npm test\x1b[0m`
      + `\x1b[${DARK.toolTail}m · exit 0 · 2.1s\x1b[0m`,
  );
});
