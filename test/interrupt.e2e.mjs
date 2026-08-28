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
      const plan = planResponse(payload);
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
      frame({
        type: "message_delta",
        delta: { stop_reason: (plan.tools?.length ?? 0) > 0 ? "tool_use" : "end_turn" },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      response.end();
    });
  });
  return {
    requests: () => requests,
    reset: () => { requests = []; },
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
  const bashUses = messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Bash"));
  const interrupted = messages.some((message) =>
    message.role === "user" && typeof message.content === "string" && message.content === INTERRUPT_TEXT);
  if (interrupted) return { text: `ACK interrupt after ${bashUses.length} bash calls` };
  const firstUser = messages.find((message) => message.role === "user");
  const firstText = typeof firstUser?.content === "string" ? firstUser.content
    : Array.isArray(firstUser?.content) ? firstUser.content.map((block) => block.text ?? "").join(" ") : "";
  if (firstText.includes("PLAN DECLINE")) {
    return { tools: [{ id: "enter-plan", name: "EnterPlanMode", input: {} }] };
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
  console.log("\n== queued automatic compaction");
  mock.reset();
  const events = [];
  const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
    name: "queued automatic compaction",
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
  check("user input queues alongside automatic compaction", queued.status === 202, JSON.stringify(queued));
  await finished;

  const completedTool = events.findIndex((event) => event.toolCall?.name === "Bash" && event.toolCall.status === "complete");
  const compactionStarted = events.findIndex((event) => event.event === "auto_compaction_start");
  check("automatic compaction waited for the current tool",
    completedTool >= 0 && compactionStarted > completedTool, `${completedTool} -> ${compactionStarted}`);
  check("automatic compaction completed in the same run",
    events.some((event) => event.event === "auto_compaction_complete"));
  const compactionRequest = mock.requests().find((request) => !request.tools);
  check("the compaction request omitted the system prompt",
    compactionRequest && !Object.hasOwn(compactionRequest, "system"), JSON.stringify(compactionRequest?.system));
  const compactionCompleted = events.findIndex((event) => event.event === "auto_compaction_complete");
  const userInjected = events.findIndex((event) => event.event === "user_message");
  check("priority-one compaction ran before priority-two user input",
    compactionCompleted >= 0 && userInjected > compactionCompleted, `${compactionCompleted} -> ${userInjected}`);

  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("automatic compaction persisted a summary", snapshot.session.compaction?.summary === "Summary:\ncompacted context");
  check("queued user input remained present after compaction",
    snapshot.session.messages.some((message) => message.role === "user" && message.content === INTERRUPT_TEXT));
  check("the model continued against compacted history",
    snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "continued after automatic compaction");
  const continuedRequest = mock.requests().find((request) =>
    request.tools && JSON.stringify(request.messages).includes("compacted context"));
  check("post-compaction context has the system prompt followed by the compact message",
    Array.isArray(continuedRequest?.system)
      && continuedRequest.system.length > 0
      && continuedRequest.messages[0]?.role === "user"
      && JSON.stringify(continuedRequest.messages[0]).includes("generated summary"));
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
  const compactionStarted = events.findIndex((event) => event.event === "auto_compaction_start");
  check("automatic compaction runs after a terminal tool result",
    terminalResult >= 0 && compactionStarted > terminalResult, `${terminalResult} -> ${compactionStarted}`);
  check("terminal-result compaction completed before the stream ended",
    events.some((event) => event.event === "auto_compaction_complete"));
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("terminal-result compaction persisted its summary",
    snapshot.session.compaction?.summary === "Summary:\ncompacted context");
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

  check("automatic compaction satisfied the queued manual compact",
    events.filter((event) => event.event === "auto_compaction_complete").length === 1);
  check("the run continued after removing the redundant command",
    events.some((event) => event.event === "continuation"));
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  check("the redundant manual compact did not cause a second compaction failure",
    !events.some((event) => event.event === "auto_compaction_error"));
  check("the continued response used the automatic summary",
    snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content
      === "continued after automatic compaction");
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

  await runQueuedCommandScenario(mock, amber);
  await runAutomaticCompactionScenario(mock, amber);
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
