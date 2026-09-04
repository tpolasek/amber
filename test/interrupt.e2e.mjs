#!/usr/bin/env node
// End-to-end coverage for queued-message interruption.
//
// Spawns a real Amber server against a scripted Anthropic-compatible mock and
// checks that a message queued while a response is streaming is injected right
// after the tool call in flight, instead of after the whole run.
//
// Usage: npm run test:e2e   (run from the repository root; builds first)
import { createServer } from "node:http";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basePort = Number(process.env.E2E_PORT ?? 38211);
const INTERRUPT_TEXT = "INTERRUPT_NOW";
const AUTO_COMPACTION_CONTINUE_MESSAGE = "We have just compacted the session, continue your work.";
const failures = [];

function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    failures.push(name);
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A scripted Anthropic-compatible provider: bash calls until interrupted. */
function createMockProvider() {
  let requests = [];
  let compactionFailuresRemaining = 0;
  let nextCompactionDelayMs = 0;
  let nextPostCompactionDelayMs = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.url.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "mock-model", display_name: "mock-model" }] }));
        return;
      }
      const payload = JSON.parse(body);
      requests.push(payload);
      if (!payload.tools && compactionFailuresRemaining > 0) {
        compactionFailuresRemaining -= 1;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "forced compaction failure" } }));
        return;
      }
      const plan = planResponse(payload);
      if (!payload.tools && nextCompactionDelayMs > 0) {
        plan.delayMs = nextCompactionDelayMs;
        nextCompactionDelayMs = 0;
      }
      if (payload.tools
        && JSON.stringify(payload.messages).includes("compacted context")
        && nextPostCompactionDelayMs > 0) {
        plan.delayMs = nextPostCompactionDelayMs;
        nextPostCompactionDelayMs = 0;
      }
      const respond = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (data) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        frame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
        let index = 0;
        if (plan.text) {
          frame({ type: "content_block_start", index, content_block: { type: "text" } });
          frame({ type: "content_block_delta", index, delta: { type: "text_delta", text: plan.text } });
          frame({ type: "content_block_stop", index });
          index += 1;
        }
        for (const tool of plan.tools ?? []) {
          frame({
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: tool.id, name: tool.name ?? "Bash" },
          });
          frame({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input ?? { command: tool.command }) },
          });
          frame({ type: "content_block_stop", index });
          index += 1;
        }
        const finish = () => {
          frame({
            type: "message_delta",
            delta: { stop_reason: plan.stopReason ?? ((plan.tools?.length ?? 0) > 0 ? "tool_use" : "end_turn") },
            usage: { input_tokens: 10, output_tokens: 2 },
          });
          response.end();
        };
        // holdOpenMs keeps the response streaming after its tool calls are
        // complete, modeling a slow model that spent effort on the request.
        if (plan.holdOpenMs) setTimeout(finish, plan.holdOpenMs);
        else finish();
      };
      if (plan.delayMs) setTimeout(respond, plan.delayMs);
      else respond();
    });
  });
  return {
    requests: () => requests,
    reset: () => {
      requests = [];
      compactionFailuresRemaining = 0;
      nextCompactionDelayMs = 0;
      nextPostCompactionDelayMs = 0;
    },
    failNextCompaction: () => { compactionFailuresRemaining += 1; },
    delayNextCompaction: (delayMs) => { nextCompactionDelayMs = delayMs; },
    delayNextPostCompactionResponse: (delayMs) => { nextPostCompactionDelayMs = delayMs; },
    listen: (port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => server.close(),
  };
}

function planResponse(payload) {
  const messages = payload.messages;
  if (!payload.tools) return { text: "<summary>compacted context</summary>" };
  if (JSON.stringify(messages).includes("compacted context")) {
    return { text: "continued after automatic compaction" };
  }
  if (JSON.stringify(messages).includes("<task-notification>")) {
    return { text: "parent received background result" };
  }
  const bashUses = messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Bash"));
  const interrupted = messages.some((message) =>
    message.role === "user" && typeof message.content === "string" && message.content === INTERRUPT_TEXT);
  if (interrupted) return { text: `ACK interrupt after ${bashUses.length} bash calls` };
  const firstUser = messages.find((message) => message.role === "user");
  const firstText = typeof firstUser?.content === "string" ? firstUser.content
    : Array.isArray(firstUser?.content) ? firstUser.content.map((block) => block.text ?? "").join(" ") : "";
  if (firstText.includes("BACKGROUND CHILD DELAY")) {
    return { text: "background child complete", delayMs: 1_500 };
  }
  if (firstText.includes("MAX TOKENS SCENARIO")) {
    return { text: "partial response before the limit", stopReason: "max_tokens" };
  }
  if (firstText.includes("STREAM HOLD")) {
    return { tools: [{ id: "stream-hold-bash", command: "echo held" }], holdOpenMs: 1_500 };
  }
  if (firstText.includes("STOPPED CHILD DELAY")) {
    return { text: "background child complete", delayMs: 3_000 };
  }
  if (firstText.includes("STOPPED AGENT SCENARIO")) {
    const agentUses = messages
      .filter((message) => message.role === "assistant" && Array.isArray(message.content))
      .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Agent"));
    return agentUses.length === 0
      ? {
          tools: [{
            id: "stopped-background-agent",
            name: "Agent",
            input: {
              description: "Delayed background child",
              prompt: "STOPPED CHILD DELAY",
              subagent_type: "general-purpose",
              run_in_background: true,
            },
          }],
        }
      : { text: "parent continued without waiting" };
  }
  if (firstText.includes("BACKGROUND AGENT SCENARIO")) {
    const agentUses = messages
      .filter((message) => message.role === "assistant" && Array.isArray(message.content))
      .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Agent"));
    return agentUses.length === 0
      ? {
          tools: [{
            id: "background-agent",
            name: "Agent",
            input: {
              description: "Delayed background child",
              prompt: "BACKGROUND CHILD DELAY",
              subagent_type: "general-purpose",
              run_in_background: true,
            },
          }],
        }
      : { text: "parent continued without waiting" };
  }
  if (firstText.includes("AGENT COMPACTION SCENARIO") || firstText.includes("COMPACTING AGENT SCENARIO")) {
    const compacting = firstText.includes("COMPACTING AGENT SCENARIO");
    const agentUses = messages
      .filter((message) => message.role === "assistant" && Array.isArray(message.content))
      .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Agent"));
    return agentUses.length === 0
      ? {
          tools: [{
            id: compacting ? "compacting-agent" : "non-compacting-agent",
            name: "Agent",
            input: {
              description: "Compaction behavior child",
              prompt: compacting ? "AGENT CHILD COMPACT" : "AGENT CHILD NO COMPACT",
              subagent_type: compacting ? "compacting" : "general-purpose",
            },
          }],
        }
      : { text: "parent received agent result" };
  }
  // Child agent sessions: distinct, verbose bash calls cross the compact
  // threshold while keeping the parent's own history below it.
  if (firstText.includes("AGENT CHILD")) {
    if (bashUses.length >= 10) return { text: "agent child finished" };
    return { tools: [{ id: `child-bash-${bashUses.length + 1}`, command: `echo ${"x".repeat(300)} ${bashUses.length + 1}` }] };
  }
  if (firstText.includes("PLAN DECLINE")) {
    return { tools: [{ id: "enter-plan", name: "EnterPlanMode", input: {} }] };
  }
  if (firstText.includes("DELETE DURING COMPACTION")) {
    return { text: "ready to compact" };
  }
  // A "DISTINCT" prompt issues one differently-input bash call per round, so
  // the tool-loop detector lets the run finish on its own.
  if (firstText.includes("DISTINCT")) {
    if (bashUses.length >= 6) return { text: "ran every command without interruption" };
    return { tools: [{ id: `bash-${bashUses.length + 1}`, command: `echo tick ${bashUses.length + 1}` }] };
  }
  // A "MULTI" prompt answers with four tool calls at once; otherwise one per response.
  if (firstText.includes("MULTI")) {
    return { tools: [0, 1, 2, 3].map((i) => ({ id: `multi-${bashUses.length}-${i}`, command: "sleep 1" })) };
  }
  if (bashUses.length >= 10) return { text: "ran every command without interruption" };
  return { tools: [{ id: `bash-${bashUses.length + 1}`, command: "sleep 1" }] };
}

async function readStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function amberUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

function startAmber(runDirectory, port, options = {}) {
  const child = spawn(process.execPath, [join(repositoryRoot, "dist", "src", "server.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: join(runDirectory, "home"),
      DATA_DIR: join(runDirectory, `data-${port}`),
      PORT: String(port),
      HOST: "127.0.0.1",
      // Keep the stub directory on PATH so a browser launch would be recorded.
      PATH: `${join(runDirectory, "bin")}:${process.env.PATH ?? ""}`,
      ...(options.suppressBrowser ? { AMBER_NO_BROWSER: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk));
  child.stderr.on("data", (chunk) => log.push(chunk));
  const exit = new Promise((resolve) => child.once("exit", resolve));
  process.once("exit", () => child.kill());
  return {
    port,
    log: () => log.join(""),
    stop: async () => {
      child.kill();
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
    },
  };
}

async function startAmberReady(runDirectory, port, options) {
  const amber = startAmber(runDirectory, port, options);
  await waitFor(async () => {
    try {
      await fetch(amberUrl(port, "/api/config"));
      return true;
    } catch {
      return false;
    }
  }, 20_000, `the Amber server on port ${port} to start`);
  return amber;
}

/**
 * Runs one session and queues the interrupt message once the wait condition is
 * met: `"running"` waits for a bash call to be in flight, a number waits for
 * that many completed bash calls.
 */
async function runScenario(mock, amber, label, prompt, waitMode) {
  console.log(`\n== ${label}`);
  mock.reset();
  const events = [];
  const started = Date.now();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), { name: label, path: tmpdir() });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: prompt }),
  });
  if (!streamResponse.ok) throw new Error(`message stream failed: ${await streamResponse.text()}`);
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));

  const bashesSeen = (status) => events.flatMap((event) => event.toolCall ? [event.toolCall] : [])
    .filter((call) => call.name === "Bash" && call.status === status).length;
  await waitFor(
    () => waitMode === "running" ? bashesSeen("running") >= 1 : bashesSeen("complete") >= waitMode,
    30_000,
    "bash calls to reach the wait condition",
  );

  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: INTERRUPT_TEXT,
    kind: "message",
  });
  check("queue endpoint accepts the message", queued.status === 202 && queued.body.queued === true, JSON.stringify(queued));
  await finished;

  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const bashes = snapshot.session.messages
    .flatMap((message) => message.toolCalls ?? [])
    .filter((call) => call.name === "Bash");
  const completed = bashes.filter((call) => call.status === "complete");
  const skipped = bashes.filter((call) => call.status === "error");
  const userMessages = snapshot.session.messages.filter((message) => message.role === "user" && message.kind === undefined);
  const expectedComplete = waitMode === "running" ? 1 : waitMode + 1;

  console.log(`  bash: ${completed.length} complete / ${skipped.length} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  check("queued message was injected mid-run",
    events.some((event) => event.event === "user_message" && event.message?.content === INTERRUPT_TEXT));
  check("queued message persisted in the session",
    userMessages.some((message) => message.content === INTERRUPT_TEXT));
  // The in-flight call may or may not have started yet when the queue lands, so
  // the invariant is "nothing runs past the interruption", not an exact count.
  check(`at most ${expectedComplete} bash call(s) ran`, completed.length <= expectedComplete, `got ${completed.length}`);
  const injectionIndex = events.findIndex((event) => event.event === "user_message");
  const ranAfterInjection = events.some((event, index) => index > injectionIndex
    && event.toolCall?.name === "Bash"
    && (event.toolCall.status === "running" || event.toolCall.status === "complete"));
  check("no bash call ran after the interruption", !ranAfterInjection);
  const finalText = snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
  check("model responded after the interruption",
    finalText.includes(`ACK interrupt after ${bashes.length} bash calls`), finalText);

  // The mock saw valid history: every tool_use has a tool_result, then the user message.
  const afterInterrupt = mock.requests().at(-1);
  const toolUses = afterInterrupt.messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === "tool_use"));
  const toolResults = afterInterrupt.messages
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  check("every tool_use has a tool_result in the next model request",
    toolUses.length === toolResults.length && toolUses.length > 0,
    `${toolUses.length} uses / ${toolResults.length} results`);
  check("skipped calls report an error result to the model",
    skipped.length === 0 || toolResults.some((result) => result.is_error && String(result.content).includes("skipped")));
  check("queued message reached the model after the tool results",
    afterInterrupt.messages.some((message) => message.role === "user" && message.content === INTERRUPT_TEXT));

  return { skipped, sessionId };
}

/**
 * The reported case: the model streams a tool call (spending real effort on
 * the request) while the response is still open, and the user queues a message
 * in that window. The streamed call must execute; the interrupt lands right
 * after it finishes instead of killing the write with "NOT RUN".
 */
async function runStreamingHoldInterruptScenario(mock, amber) {
  console.log("\n== queued message while the tool call is still streaming");
  mock.reset();
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "streaming hold interrupt",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "STREAM HOLD run one bash command." }),
  });
  if (!streamResponse.ok) throw new Error(`message stream failed: ${await streamResponse.text()}`);
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));

  // The tool call is fully streamed but the response has not ended, so the
  // call is generated yet not executing — exactly when a user would queue.
  await waitFor(
    () => events.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "queued"),
    30_000,
    "the streamed tool call to appear while the response is held open",
  );
  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: INTERRUPT_TEXT,
    kind: "message",
  });
  check("queue endpoint accepts the message mid-stream", queued.status === 202, JSON.stringify(queued));
  await finished;

  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const bashes = snapshot.session.messages
    .flatMap((message) => message.toolCalls ?? [])
    .filter((call) => call.name === "Bash");
  check("the streamed tool call executed instead of being killed",
    bashes.length === 1 && bashes[0].status === "complete" && bashes[0].output.includes("held"),
    JSON.stringify(bashes.map((call) => [call.status, call.statusDisplay?.text])));
  const completionIndex = events.findIndex((event) =>
    event.toolCall?.name === "Bash" && event.toolCall.status === "complete");
  const injectionIndex = events.findIndex((event) => event.event === "user_message");
  check("the queued message was injected after the call finished",
    completionIndex >= 0 && injectionIndex > completionIndex, `${completionIndex} -> ${injectionIndex}`);
  const finalText = snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
  check("the model answered the queued message",
    finalText === "ACK interrupt after 1 bash calls", finalText);
}

async function runQueuedCommandScenario(mock, amber) {
  console.log("\n== queued built-in command");
  mock.reset();
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "queued built-in command",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "MULTI run four bash commands." }),
  });
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));
  await waitFor(
    () => events.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the first queued-command bash call to start",
  );

  const instant = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/commands`), {
    command: "/context",
  });
  check("non-blocking command runs during a response",
    instant.status === 200 && instant.body.command === "context", JSON.stringify(instant));

  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: "/name queued-title",
    kind: "command",
  });
  check("queue endpoint accepts a built-in command", queued.status === 202, JSON.stringify(queued));
  await finished;

  let snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("queued command was not sent to the model",
    !snapshot.session.messages.some((message) => message.role === "user" && message.content === "/name queued-title"));
  check("non-blocking command was rendered as command UI",
    snapshot.session.messages.some((message) => message.content === "/context" && message.kind === "command"));
  check("queued command ended the interrupted model run", mock.requests().length === 1, `${mock.requests().length} requests`);

  const command = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/commands`), {
    command: "/name queued-title",
  });
  check("queued command can be dispatched through the command endpoint",
    command.status === 200 && command.body.command === "name", JSON.stringify(command));
  snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("dispatched command applied its command behavior", snapshot.session.title === "queued-title", snapshot.session.title);
}

async function runAutomaticCompactionScenario(mock, amber) {
  console.log("\n== server-inserted automatic compaction");
  mock.reset();
  mock.delayNextPostCompactionResponse(1_500);
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "server-inserted automatic compaction",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Run one command, then continue. ${"x".repeat(3_000)}` }),
  });
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));
  await waitFor(
    () => events.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the automatic-compaction bash call to start",
  );
  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: INTERRUPT_TEXT,
    kind: "message",
  });
  check("user input queues alongside the inserted compaction", queued.status === 202, JSON.stringify(queued));
  await waitFor(
    () => events.some((event) => event.event === "continuation"),
    30_000,
    "the model turn to resume after automatic compaction",
  );
  const activeSnapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("the resumed outer turn remains registered as active", activeSnapshot.active === true);
  const concurrent = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    content: "must not start concurrently",
  });
  check("a concurrent message is rejected while the resumed turn runs",
    concurrent.status === 409, JSON.stringify(concurrent));
  const deletion = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`), { method: "DELETE" });
  check("delete is rejected while the resumed outer turn runs", deletion.status === 409, `${deletion.status}`);
  await finished;

  const completedTool = events.findIndex((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "complete");
  const compactionStarted = events.findIndex((event) => event.event === "compaction_start");
  check("compaction waited for the current tool",
    completedTool >= 0 && compactionStarted > completedTool, `${completedTool} -> ${compactionStarted}`);
  const compactionCompleted = events.findIndex((event) => event.event === "compaction_complete");
  const doneIndex = events.findIndex((event) => event.event === "done");
  check("compaction completed before the run ended",
    compactionCompleted >= 0 && doneIndex > compactionCompleted, `${compactionCompleted} -> ${doneIndex}`);
  check("compaction streamed live progress", events.some((event) => event.event === "compaction_progress"));
  const compactionRequest = mock.requests().find((request) => !request.tools);
  check("the compaction request omitted the system prompt",
    compactionRequest && !Object.hasOwn(compactionRequest, "system"), JSON.stringify(compactionRequest?.system));

  let snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("compaction persisted a summary", snapshot.session.compaction?.summary === "Summary:\ncompacted context");
  const autoContinuation = events.findIndex((event) =>
    event.event === "user_message" && event.message?.content === AUTO_COMPACTION_CONTINUE_MESSAGE);
  check("automatic compaction inserted a continuation message",
    autoContinuation > compactionCompleted
      && snapshot.session.messages.some((message) =>
        message.role === "user" && message.content === AUTO_COMPACTION_CONTINUE_MESSAGE),
    `${compactionCompleted} -> ${autoContinuation}`);
  const userInjected = events.findIndex((event) =>
    event.event === "user_message" && event.message?.content === INTERRUPT_TEXT);
  check("the accepted queued message was injected after compaction",
    userInjected > compactionCompleted
      && snapshot.session.messages.some((message) => message.role === "user" && message.content === INTERRUPT_TEXT),
    `${compactionCompleted} -> ${userInjected}`);
  check("the model resumed the tool-driven turn after automatic compaction",
    snapshot.session.messages.filter((message) => message.role === "assistant" && message.kind !== "compact-banner")
      .at(-1)?.content === "continued after automatic compaction");
  const resumedRequest = mock.requests().find((request) => request.tools
    && JSON.stringify(request.messages).includes("compacted context"));
  check("the resumed turn used the compacted history",
    Array.isArray(resumedRequest?.system)
      && resumedRequest.system.length > 0
      && resumedRequest.messages[0]?.role === "user"
      && JSON.stringify(resumedRequest.messages[0]).includes("generated summary"));
}

async function runFailedCompactionDetachedObserverScenario(mock, amber) {
  console.log("\n== failed automatic compaction with detached observer");
  mock.reset();
  mock.failNextCompaction();
  const ownerEvents = [];
  const observerEvents = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "failed compaction detached observer",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Run one command, then continue. ${"x".repeat(3_000)}` }),
  });
  if (!streamResponse.ok) throw new Error(`message stream failed: ${await streamResponse.text()}`);
  const ownerFinished = readStream(streamResponse, (event, data) => ownerEvents.push({ event, ...data }));

  // Observe through the connection used by a second tab rather than relying
  // on the message request's client-side finally block to resend input.
  const observerResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/events`));
  if (!observerResponse.ok) throw new Error(`observer stream failed: ${await observerResponse.text()}`);
  const observerFinished = readStream(observerResponse, (event, data) => observerEvents.push({ event, ...data }));
  await waitFor(
    () => observerEvents.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the detached observer to see the bash call",
  );

  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: INTERRUPT_TEXT,
    kind: "message",
  });
  check("detached observer queues a message before compaction failure",
    queued.status === 202 && queued.body.queued === true, JSON.stringify(queued));
  await Promise.all([ownerFinished, observerFinished]);

  const compactionError = observerEvents.findIndex((event) => event.event === "compaction_error");
  const userInjected = observerEvents.findIndex((event) =>
    event.event === "user_message" && event.message?.content === INTERRUPT_TEXT);
  const doneIndex = observerEvents.findIndex((event) => event.event === "done");
  check("detached observer saw the forced compaction failure", compactionError >= 0);
  check("server delivered the accepted message after compaction failure",
    userInjected > compactionError && doneIndex > userInjected,
    `${compactionError} -> ${userInjected} -> ${doneIndex}`);

  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const delivered = snapshot.session.messages.filter((message) =>
    message.role === "user" && message.content === INTERRUPT_TEXT);
  check("failed compaction persisted the queued message exactly once", delivered.length === 1, `${delivered.length}`);
  check("the model handled the queued message without client re-dispatch",
    snapshot.session.messages
      .filter((message) => message.role === "assistant" && message.kind !== "compact-banner")
      .some((message) => message.content?.startsWith("ACK interrupt after")));
}

async function runDeleteDuringCompactionScenario(mock, amber) {
  console.log("\n== delete during registered compaction");
  mock.reset();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "delete during compaction",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const messageResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "DELETE DURING COMPACTION" }),
  });
  if (!messageResponse.ok) throw new Error(`message stream failed: ${await messageResponse.text()}`);
  await readStream(messageResponse, () => undefined);

  mock.delayNextCompaction(5_000);
  const compactRequest = postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/commands`), {
    command: "/compact",
  });
  await waitFor(async () => {
    const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`));
    if (!response.ok) return false;
    return Boolean((await response.json()).compaction);
  }, 10_000, "the manual compaction to register");

  const deletion = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`), { method: "DELETE" });
  const deletionBody = await deletion.json().catch(() => ({}));
  const compactResult = await compactRequest;
  check("delete waits for compaction abort cleanup and succeeds",
    deletion.status === 200 && deletionBody.deletedSessionId === sessionId,
    `${deletion.status} ${JSON.stringify(deletionBody)}`);
  check("the aborted compact command reports failure", compactResult.status === 502, JSON.stringify(compactResult));
  const missing = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`));
  check("the deleted session remains absent after compaction cleanup", missing.status === 404, `${missing.status}`);
}

/**
 * A dropped client connection (window refresh, closed tab) must not abort the
 * run: it keeps streaming server-side, a re-attached observer sees it through,
 * and an explicit /abort still stops it.
 */
async function runDisconnectedClientScenario(mock, amber) {
  console.log("\n== client disconnect continues in background");
  mock.reset();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "client disconnect continues in background",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const ownerController = new AbortController();
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "DISTINCT run six bash commands one at a time." }),
    signal: ownerController.signal,
  });
  if (!streamResponse.ok) throw new Error(`message stream failed: ${await streamResponse.text()}`);
  const ownerEvents = [];
  const ownerRead = readStream(streamResponse, (event, data) => ownerEvents.push({ event, ...data }));
  await waitFor(
    () => ownerEvents.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the first bash call to start",
  );

  // Drop the connection the way a window refresh does.
  ownerController.abort();
  await ownerRead.catch(() => undefined);

  const detachedSnapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("the run stays active after the client disconnects", detachedSnapshot.active === true);
  const concurrent = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    content: "must not start concurrently",
  });
  check("a message sent after the disconnect is rejected", concurrent.status === 409, JSON.stringify(concurrent));

  // The refreshed tab re-attaches through the observe endpoint and watches the run out.
  const observerEvents = [];
  const observerResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/events`));
  if (!observerResponse.ok) throw new Error(`observer stream failed: ${await observerResponse.text()}`);
  const observerRead = readStream(observerResponse, (event, data) => observerEvents.push({ event, ...data }));
  await waitFor(
    () => observerEvents.some((event) => event.event === "done"),
    60_000,
    "the detached run to finish while observed",
  );
  check("the re-attached observer received live tool events",
    observerEvents.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "complete"));
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const bashes = snapshot.session.messages
    .flatMap((message) => message.toolCalls ?? [])
    .filter((call) => call.name === "Bash");
  check("the detached run executed every bash call",
    bashes.length === 6 && bashes.every((call) => call.status === "complete"),
    `${bashes.filter((call) => call.status === "complete").length}/${bashes.length}`);
  check("the detached run produced the final response",
    snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "ran every command without interruption");
  await observerRead.catch(() => undefined);

  // An explicit abort still stops a run nobody is attached to.
  const abortEvents = [];
  const { body: second } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "explicit abort after disconnect",
    path: tmpdir(),
  });
  const abortSessionId = second.session.id;
  const abortController = new AbortController();
  const abortResponse = await fetch(amberUrl(amber.port, `/api/sessions/${abortSessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "MULTI run four bash commands." }),
    signal: abortController.signal,
  });
  if (!abortResponse.ok) throw new Error(`abort stream failed: ${await abortResponse.text()}`);
  const abortRead = readStream(abortResponse, (event, data) => abortEvents.push({ event, ...data }));
  await waitFor(
    () => abortEvents.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the abort scenario bash call to start",
  );
  abortController.abort();
  await abortRead.catch(() => undefined);
  const abortObserver = await fetch(amberUrl(amber.port, `/api/sessions/${abortSessionId}/events`));
  const abortObserverRead = readStream(abortObserver, (event, data) => abortEvents.push({ event, ...data }));
  const aborted = await postJson(amberUrl(amber.port, `/api/sessions/${abortSessionId}/abort`), {});
  check("explicit abort stops the detached run",
    aborted.body.aborted === true && aborted.body.sessionIds.includes(abortSessionId), JSON.stringify(aborted));
  await waitFor(
    () => abortEvents.some((event) => event.event === "error"),
    30_000,
    "the aborted run to report its error",
  );
  const finalSnapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${abortSessionId}`))).json();
  check("the aborted run is no longer active", finalSnapshot.active === false);
  check("the aborted run reported the stop to observers",
    abortEvents.some((event) => event.event === "error" && event.error === "Session aborted"),
    JSON.stringify(abortEvents.filter((event) => event.event === "error")));
  await abortObserverRead.catch(() => undefined);
}

async function runBackgroundAgentScenario(mock, amber) {
  console.log("\n== background agent launch");
  mock.reset();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "background agent launch",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const started = Date.now();
  const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "BACKGROUND AGENT SCENARIO" }),
  });
  await readStream(response, () => undefined);
  const parentDuration = Date.now() - started;
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const agentCall = snapshot.session.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((call) => call.name === "Agent");
  check("background Agent returns before its child completes",
    parentDuration < 1_000, `${parentDuration}ms`);
  check("background Agent launch is persisted as non-blocking",
    agentCall?.status === "complete"
      && agentCall.statusDisplay?.text === "BACKGROUND"
      && Boolean(agentCall.agentSessionId), JSON.stringify(agentCall));
  check("parent model continues immediately after the background launch",
    snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "parent continued without waiting");

  const childId = agentCall?.agentSessionId;
  if (!childId) return;
  const initialChild = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
  check("background child remains active after the parent turn ends",
    initialChild.session?.agentStatus === "running", initialChild.session?.agentStatus);
  await waitFor(async () => {
    const child = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
    return child.session?.agentStatus === "complete";
  }, 5_000, "the background agent to complete");
  const completedChild = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
  check("background child persists its result",
    completedChild.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "background child complete");

  const notificationResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Use any completed background results." }),
  });
  await readStream(notificationResponse, () => undefined);
  const notifiedParent = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const notification = notifiedParent.session.messages.find((message) => message.kind === "agent-notification");
  check("the next parent turn receives the background result notification",
    notification?.content.includes(`<task-id>${childId}</task-id>`)
      && notification.content.includes("<status>complete</status>")
      && notification.content.includes("background child complete"), notification?.content);
  check("the parent LLM responds with the delivered background context",
    notifiedParent.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "parent received background result");
}

async function runStoppedBackgroundAgentScenario(mock, amber) {
  console.log("\n== manually stopped background agent");
  mock.reset();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "manually stopped background agent",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "STOPPED AGENT SCENARIO" }),
  });
  await readStream(response, () => undefined);
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const agentCall = snapshot.session.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((call) => call.name === "Agent");
  const childId = agentCall?.agentSessionId;
  if (!childId) {
    check("the stopped-agent scenario launches a background agent", false, JSON.stringify(agentCall));
    return;
  }
  const initialChild = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
  check("the background child is running before the stop",
    initialChild.session?.agentStatus === "running", initialChild.session?.agentStatus);

  const aborted = await postJson(amberUrl(amber.port, `/api/sessions/${childId}/abort`), {});
  check("the manual stop aborts the child run",
    aborted.body.aborted === true && aborted.body.sessionIds.includes(childId), JSON.stringify(aborted));
  await waitFor(async () => {
    const child = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
    return child.session?.agentStatus === "stopped";
  }, 5_000, "the stopped agent to record status 'stopped'");
  const stoppedChild = await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json();
  check("the stopped agent records the manual stop as its last message",
    stoppedChild.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "Response interrupted: User manually stopped the agent.",
    JSON.stringify(stoppedChild.session.messages?.at(-1)?.content));

  const notificationResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Use any completed background results." }),
  });
  await readStream(notificationResponse, () => undefined);
  const notifiedParent = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const notification = notifiedParent.session.messages.find((message) => message.kind === "agent-notification");
  check("a stopped agent notifies with a distinct stopped status",
    notification?.content.includes(`<task-id>${childId}</task-id>`)
      && notification.content.includes("<status>stopped</status>")
      && notification.content.includes("User manually stopped the agent"), notification?.content);
}

async function runTruncatedResponseScenario(mock, amber) {
  console.log("\n== token-limited provider response");
  mock.reset();
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "token-limited provider response",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "MAX TOKENS SCENARIO" }),
  });
  await readStream(response, () => undefined);
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  const last = snapshot.session.messages.filter((message) => message.role === "assistant").at(-1);
  check("a token-limited response records why it was cut off",
    last?.content === "partial response before the limit\n\nResponse interrupted: Ran out of tokens.",
    JSON.stringify(last?.content));
  check("a token-limited response still ends its turn normally",
    snapshot.active === false, JSON.stringify(snapshot.active));
}

async function runAgentCompactionScenario(mock, amber) {
  console.log("\n== agent compaction opt-in");
  const runAgent = async (parentPrompt) => {
    mock.reset();
    const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
      name: parentPrompt,
      path: tmpdir(),
    });
    const sessionId = body.session.id;
    const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: parentPrompt }),
    });
    await readStream(response, () => undefined);
    const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
    const agentCall = snapshot.session.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.name === "Agent");
    const childId = agentCall?.agentSessionId;
    const child = childId
      ? await (await fetch(amberUrl(amber.port, `/api/sessions/${childId}`))).json()
      : undefined;
    return { child, requests: mock.requests() };
  };

  const disabled = await runAgent("AGENT COMPACTION SCENARIO");
  check("agent without compact never auto-compacts",
    disabled.child?.session?.compaction === undefined
      && disabled.requests.every((request) => request.tools),
    JSON.stringify(disabled.child?.session?.compaction ?? null));
  check("the compact-disabled agent finished its tool loop",
    disabled.child?.session?.messages
      .filter((message) => message.role === "assistant").at(-1)?.content === "agent child finished",
    JSON.stringify(disabled.child?.session?.messages?.at(-1)?.content));

  const enabled = await runAgent("COMPACTING AGENT SCENARIO");
  check("agent with compact = true auto-compacts its own context",
    enabled.child?.session?.compaction?.summary === "Summary:\ncompacted context"
      && enabled.requests.some((request) => !request.tools),
    JSON.stringify(enabled.child?.session?.compaction?.summary ?? null));
}

async function runTerminalToolCompactionScenario(mock, amber) {
  console.log("\n== automatic compaction after terminal tool result");
  mock.reset();
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "terminal tool automatic compaction",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `PLAN DECLINE ${"x".repeat(3_000)}` }),
  });
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));
  await waitFor(
    () => events.some((event) => event.event === "plan_mode_request"),
    30_000,
    "the plan-mode decision request",
  );
  const request = events.find((event) => event.event === "plan_mode_request");
  const decision = await postJson(
    amberUrl(amber.port, `/api/sessions/${sessionId}/plan-mode/${request.toolUseId}/decision`),
    { approved: false },
  );
  check("terminal plan decision was accepted", decision.status === 200, JSON.stringify(decision));
  await finished;

  const terminalResult = events.findIndex((event) =>
    event.toolCall?.name === "EnterPlanMode" && event.toolCall.statusDisplay?.text === "DECLINED");
  const compactionStarted = events.findIndex((event) => event.event === "compaction_start");
  check("automatic compaction runs after a terminal tool result",
    terminalResult >= 0 && compactionStarted > terminalResult, `${terminalResult} -> ${compactionStarted}`);
  check("terminal-result compaction completed before the stream ended",
    events.some((event) => event.event === "compaction_complete"));
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("terminal-result compaction persisted its summary",
    snapshot.session.compaction?.summary === "Summary:\ncompacted context");
  check("terminal-result compaction keeps the agent going with an inserted message",
    snapshot.session.messages.some((message) =>
      message.role === "user" && message.content === AUTO_COMPACTION_CONTINUE_MESSAGE)
      && snapshot.session.messages.filter((message) =>
        message.role === "assistant" && message.kind !== "compact-banner").at(-1)?.content
        === "continued after automatic compaction");
}

async function runRedundantManualCompactionScenario(mock, amber) {
  console.log("\n== automatic compaction supersedes queued manual compact");
  mock.reset();
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "redundant manual compaction",
    path: tmpdir(),
  });
  const sessionId = body.session.id;
  const streamResponse = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Run one command, then continue. ${"x".repeat(3_000)}` }),
  });
  const finished = readStream(streamResponse, (event, data) => events.push({ event, ...data }));
  await waitFor(
    () => events.some((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "running"),
    30_000,
    "the redundant-compaction bash call to start",
  );
  const queued = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/queued-message`), {
    content: "/compact",
    kind: "command",
  });
  check("manual compact queues alongside automatic compaction", queued.status === 202, JSON.stringify(queued));
  await finished;

  check("the server-inserted compaction ran exactly once",
    events.filter((event) => event.event === "compaction_complete").length === 1);
  const compactionCompleted = events.findIndex((event) => event.event === "compaction_complete");
  const doneIndex = events.findIndex((event) => event.event === "done");
  const continuationIndex = events.findIndex((event) => event.event === "continuation");
  check("the run resumed after the compaction",
    compactionCompleted >= 0 && continuationIndex > compactionCompleted && doneIndex > continuationIndex,
    `${compactionCompleted} -> ${continuationIndex} -> ${doneIndex}`);
  check("the queued manual compact did not cause a second compaction failure",
    !events.some((event) => event.event === "compaction_error"));
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("the automatic summary was persisted",
    snapshot.session.compaction?.summary === "Summary:\ncompacted context");
  check("the model continued the interrupted turn after compaction",
    snapshot.session.messages.some((message) => message.content === "continued after automatic compaction"));
}

async function writeBrowserStubs(runDirectory) {
  // A stub on PATH records any browser launch the server attempts, so the run
  // can prove that e2e mode opens no window. Covers the linux and darwin openers.
  const marker = join(runDirectory, "browser-opened");
  const stub = `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\nexit 0\n`;
  const directory = join(runDirectory, "bin");
  await mkdir(directory, { recursive: true });
  for (const command of ["xdg-open", "open"]) {
    await writeFile(join(directory, command), stub);
    await chmod(join(directory, command), 0o755);
  }
  return marker;
}

const runDirectory = await mkdtemp(join(tmpdir(), "amber-e2e-"));
const browserMarker = await writeBrowserStubs(runDirectory);
await mkdir(join(runDirectory, "home", ".amber"), { recursive: true });
await writeFile(join(runDirectory, "home", ".amber", "settings.toml"), [
  'theme = "dark"',
  "default_provider = \"mock\"",
  "",
  "[providers.mock]",
  'api = "anthropic"',
  'auth_key = "test-key"',
  `auth_url = "http://127.0.0.1:${basePort + 1}"`,
  'default_model = "mock-model"',
  'thinking_level = "none"',
  "compact_tokens = 500",
  "",
  "[[agents]]",
  'type = "general-purpose"',
  'whenToUse = "Run e2e agent scenarios."',
  'systemPrompt = "Complete the assigned e2e task."',
  "readOnly = false",
  "",
  "[[agents]]",
  'type = "compacting"',
  'whenToUse = "Run e2e agent scenarios with compaction enabled."',
  'systemPrompt = "Complete the assigned e2e task."',
  "readOnly = false",
  "compact = true",
  "",
].join("\n"));

const mock = createMockProvider();
await mock.listen(basePort + 1);
const amber = await startAmberReady(runDirectory, basePort, { suppressBrowser: true });

try {
  const browserModule = await fetch(amberUrl(amber.port, "/built-in-commands.js"));
  check("browser command module is served",
    browserModule.status === 200 && (await browserModule.text()).includes("BUILT_IN_COMMANDS"));

  // Scenario 1: the reported case - ten sequential bash calls, queue once two finished.
  await runScenario(mock, amber, "sequential bash calls", "Run ten bash commands one at a time.", 2);

  // Scenario 2: one response with four tool calls, queue while the first runs.
  const multi = await runScenario(mock, amber, "multi-tool response", "MULTI run four bash commands.", "running");
  check("remaining tool calls of the batch were skipped",
    multi.skipped.length === 3 && multi.skipped.every((call) => call.statusDisplay?.text === "NOT RUN"),
    JSON.stringify(multi.skipped.map((call) => [call.status, call.statusDisplay])));

  // Scenario 3: queue while the response holding the streamed call is open.
  await runStreamingHoldInterruptScenario(mock, amber);

  await runQueuedCommandScenario(mock, amber);
  await runBackgroundAgentScenario(mock, amber);
  await runStoppedBackgroundAgentScenario(mock, amber);
  await runTruncatedResponseScenario(mock, amber);
  await runAgentCompactionScenario(mock, amber);
  await runAutomaticCompactionScenario(mock, amber);
  await runFailedCompactionDetachedObserverScenario(mock, amber);
  await runDeleteDuringCompactionScenario(mock, amber);
  await runDisconnectedClientScenario(mock, amber);
  await runTerminalToolCompactionScenario(mock, amber);
  await runRedundantManualCompactionScenario(mock, amber);

  // The queue endpoint rejects an idle session.
  const idle = await postJson(amberUrl(amber.port, `/api/sessions/${multi.sessionId}/queued-message`), {
    content: "hello",
    kind: "message",
  });
  check("queue endpoint rejects an idle session", idle.status === 409, JSON.stringify(idle));

  check("e2e mode opens no browser window", !(await pathExists(browserMarker)));

  // Control: without AMBER_NO_BROWSER the stub records a launch, proving the
  // check above can actually fail. Only linux and darwin openers are stubbed.
  if (process.platform === "linux" || process.platform === "darwin") {
    const control = await startAmberReady(runDirectory, basePort + 2, { suppressBrowser: false });
    try {
      await waitFor(() => pathExists(browserMarker), 5_000, "the control server to open a browser");
      check("control run confirms the browser stub works", await pathExists(browserMarker));
    } finally {
      await control.stop();
    }
  }
} finally {
  await amber.stop();
  mock.close();
  await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
}

const serverLog = amber.log();
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
if (serverLog.includes("Error") || failures.length > 0) console.log(`\n--- server log ---\n${serverLog}`);
process.exit(failures.length === 0 ? 0 : 1);
