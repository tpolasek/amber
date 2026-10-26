// End-to-end coverage for the amber terminal client.
//
// Spawns a real Amber server against a scripted Anthropic-compatible mock,
// then drives `amber cli` through a full run: streamed markdown (incl. a
// table), a hidden bash tool result, an AskUserQuestion gate answered from
// stdin, a server slash command, a skill invoked as /slash message, and
// /quit.
//
// Usage: npm run test:e2e:cli
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basePort = Number(process.env.E2E_PORT ?? 38231);
const failures = [];

function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    failures.push(name);
  }
}

function createMockProvider() {
  const requests = [];
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
      const rounds = requests.filter((entry) => entry.tools).length;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (data) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      frame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
      let index = 0;
      const text = (value) => {
        frame({ type: "content_block_start", index, content_block: { type: "text" } });
        frame({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
        frame({ type: "content_block_stop", index });
        index += 1;
      };
      const toolUse = (id, name, input) => {
        frame({ type: "content_block_start", index, content_block: { type: "tool_use", id, name } });
        frame({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        frame({ type: "content_block_stop", index });
        index += 1;
      };
      if (!payload.tools) text("compacted");
      else if (rounds === 1) {
        frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PLANNING E2E THOUGHT\n" } });
        text("CLI E2E INTRO\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        toolUse("q1", "AskUserQuestion", {
          questions: [{ question: "Pick one", header: "Pick", options: [{ label: "One", description: "First option" }, { label: "Two", description: "Second option" }], multiSelect: false }],
        });
      } else if (rounds === 2) {
        toolUse("b1", "Bash", { command: "env | grep E2E_SECRET" });
      } else if (rounds === 4) {
        toolUse("sk1", "Skill", { skill: "e2e" });
      } else if (rounds >= 5) {
        text("SKILL DONE");
      } else {
        text("ALL DONE");
      }
      frame({
        type: "message_delta",
        delta: { stop_reason: index > 0 ? "tool_use" : "end_turn" },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      response.end();
    });
  });
  return {
    requests: () => requests,
    listen: (port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => server.close(),
  };
}

function waitFor(output, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (output().includes(needle)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${JSON.stringify(needle)}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForCount(output, needle, times, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (output().split(needle).length - 1 >= times) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${times}x ${JSON.stringify(needle)}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

const mock = createMockProvider();
await mock.listen(basePort + 1);

const runDirectory = await mkdtemp(join(tmpdir(), "amber-cli-e2e-"));
const home = join(runDirectory, "home");
await mkdir(join(home, ".amber"), { recursive: true });
await writeFile(join(home, ".amber", "settings.toml"), [
  'theme = "dark"',
  'default_provider = "mock"',
  "",
  "[providers.mock]",
  'api = "anthropic"',
  'auth_key = "test-key"',
  `auth_url = "http://127.0.0.1:${basePort + 1}"`,
  'default_model = "mock-model"',
  'thinking_level = "none"',
  "",
].join("\n"));
await mkdir(join(home, ".amber", "skills", "e2e"), { recursive: true });
await writeFile(join(home, ".amber", "skills", "e2e", "SKILL.md"), [
  "---",
  "description: E2E test skill",
  "---",
  "",
  "Reply with exactly: SKILL DONE",
  "",
].join("\n"));

const serverEnv = {
  ...process.env,
  HOME: home,
  DATA_DIR: join(runDirectory, "data"),
  PORT: String(basePort + 3),
  HOST: "127.0.0.1",
  AMBER_NO_BROWSER: "1",
  E2E_SECRET: "classified-value",
};

const server = spawn(process.execPath, [join(repositoryRoot, "dist", "src", "server.js")], {
  cwd: repositoryRoot,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (chunk) => serverLog.push(chunk));
server.stderr.on("data", (chunk) => serverLog.push(chunk));
process.once("exit", () => server.kill());

for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${basePort + 3}/api/settings`);
    if (response.ok) break;
  } catch { /* not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const cli = spawn(
  process.execPath,
  [join(repositoryRoot, "dist", "src", "server.js"), "cli", "--server", `http://127.0.0.1:${basePort + 3}`, "--history", "2", "--thinking", "--new", "cli e2e"],
  { cwd: runDirectory, env: serverEnv, stdio: ["pipe", "pipe", "pipe"] },
);
const chunks = [];
cli.stdout.on("data", (chunk) => chunks.push(chunk));
cli.stderr.on("data", (chunk) => chunks.push(chunk));
const output = () => chunks.join("");
const type = (line) => cli.stdin.write(`${line}\n`);
const exitCode = new Promise((resolve) => cli.once("exit", resolve));

let failed = false;
try {
  await waitFor(output, "> ", 15_000);
  type("CLI E2E START");
  await waitFor(output, "CLI E2E INTRO", 15_000);
  await waitFor(output, "| a | b |", 5_000);
  await waitFor(output, "answer:", 15_000);
  type("1");
  await waitFor(output, "✓ Bash env | grep E2E_SECRET", 15_000);
  await waitFor(output, "ALL DONE", 15_000);
  type("/name cli-e2e-title");
  await waitFor(output, "· done", 15_000);

  // /switch: attach to a fresh session, then return to the first by id prefix.
  type("/new second");
  await waitForCount(output, "· session ", 2, 15_000);
  const sessions = (await (await fetch(`http://127.0.0.1:${basePort + 3}/api/sessions`)).json())
    .sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  type("/switch zzzz");
  await waitFor(output, "✗ no session matches 'zzzz'", 15_000);
  type(`/switch ${sessions[0].id.slice(0, 6)}`);
  await waitForCount(output, "· session ", 3, 15_000);
  await waitForCount(output, "ALL DONE", 2, 15_000);

  // /model and /effort: inspect and change the session's model and effort.
  type("/model");
  await waitFor(output, "(current)", 15_000);
  type("/model nope");
  await waitFor(output, "✗ no model matches 'nope'", 15_000);
  type("/model mock-model");
  await waitFor(output, "· model mock/mock-model", 15_000);
  type("/effort");
  await waitFor(output, "· effort none (model default)", 15_000);
  type("/effort banana");
  await waitFor(output, "✗ effort must be one of:", 15_000);
  type("/effort high");
  await waitFor(output, "· effort high", 15_000);

  // Unknown slash commands and skills both travel as messages; the server
  // refuses the former and loads the latter through the model's Skill tool.
  type("/nosuch");
  await waitFor(output, "✗ The /nosuch command doesn't exist", 15_000);
  type("/e2e");
  await waitFor(output, "✓ Skill e2e", 15_000);
  await waitFor(output, "SKILL DONE", 15_000);
  // Every finished run prints the CNTX/CSH9/CACH meters; /usage reprints them locally.
  await waitForCount(output, "CNTX", 2, 15_000);
  type("/usage");
  await waitForCount(output, "CNTX", 3, 15_000);
  type("/quit");
  check("cli exits cleanly", (await exitCode) === 0);
  check("streams markdown text", output().includes("CLI E2E INTRO"));
  check("streams thinking under a header with --thinking", output().includes("· thinking") && output().includes("PLANNING E2E THOUGHT"));
  check("renders the table", output().includes("| a | b |"));
  check("prints one line for the bash tool", output().includes("✓ Bash env | grep E2E_SECRET"));
  check("never prints tool output", !output().includes("classified-value"));
  check("prints the question gate", output().includes("Pick: Pick one") && output().includes("1) One"));
  check("switches sessions and re-attaches history", output().includes(`· session ${sessions[0].id.slice(0, 8)}`));
  check("switch errors name the missing prefix", output().includes("✗ no session matches 'zzzz'"));
  check("lists models with the current marker", output().includes("mock/mock-model  mock-model  thinking none  (current)"));
  check("selects a model by id or key", output().includes("· model mock/mock-model"));
  check("shows and sets the effort level", output().includes("· effort none (model default)") && output().includes("· effort high"));
  check("refuses unknown slash commands via the message path", output().includes("✗ The /nosuch command doesn't exist"));
  check("invokes skills as messages through the Skill tool", output().includes("✓ Skill e2e") && output().includes("SKILL DONE"));
  check("prints the context and cache meters after a run", output().includes("CNTX 0k toks · CSH9 -- · CACH --"));
  check("/usage reports the meters in the cli", output().split("CNTX").length - 1 >= 3);
  // The AskUserQuestion result is persisted as "Pick one"="One"; JSON.stringify escapes the quotes.
  check("answers post through to the run", mock.requests().some((payload) => JSON.stringify(payload.messages).includes('\\"Pick one\\"=\\"One\\"')));
} catch (error) {
  failed = true;
  console.log(`  FAIL driver :: ${error.message}`);
  failures.push("driver");
}

if (failed || failures.length > 0) {
  console.log("\n--- cli output ---");
  console.log(output());
  console.log("--- server log tail ---");
  console.log(serverLog.join("").slice(-4_000));
}
cli.kill();
server.kill();
mock.close();
await rm(runDirectory, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
