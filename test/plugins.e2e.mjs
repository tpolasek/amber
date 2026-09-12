#!/usr/bin/env node
// End-to-end coverage for the plugin system on a clean profile.
//
// Starts from an empty HOME with no marketplaces and no plugins, then drives the
// real /plugin surface against the live official marketplace on GitHub: add the
// marketplace, install superpowers, run one of its skills in a session, and
// check that disabling it takes the skill away. Nothing is cloned or symlinked
// by hand — every fetch is the server's own.
//
// Needs network access to github.com. The model is a scripted mock, so no
// provider credentials are involved.
//
// Usage: npm run test:e2e:plugins   (run from the repository root; builds first)
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basePort = Number(process.env.E2E_PORT ?? 38311);
const MARKETPLACE_SPEC = "anthropics/claude-plugins-official";
const MARKETPLACE = "claude-plugins-official";
const PLUGIN = "superpowers";
const PLUGIN_KEY = `${PLUGIN}@${MARKETPLACE}`;
const SKILL = "superpowers:brainstorming";
const SKILL_RAN = "ran the superpowers brainstorming skill";
const SKILL_MISSING = "the superpowers skill was not available";
// Marks the prompt that opens a turn, so the mock reasons about this turn only:
// an injected skill message is a plain user message too.
const TURN_MARKER = "PLUGIN SKILL TURN";
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

/**
 * A scripted Anthropic-compatible provider: it invokes the plugin skill once,
 * then answers according to whether the skill loaded.
 */
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
        frame({ type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name } });
        frame({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
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
  if (!payload.tools) return { text: "<summary>compacted context</summary>" };
  const turnStart = payload.messages.findLastIndex((message) =>
    message.role === "user" && typeof message.content === "string" && message.content.includes(TURN_MARKER));
  const turn = payload.messages.slice(turnStart + 1);
  const skillUses = turn
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.type === "tool_use" && block.name === "Skill"));
  if (skillUses.length === 0) {
    return { tools: [{ id: `skill-call-${turnStart}`, name: "Skill", input: { skill: SKILL } }] };
  }
  // "Launching skill: <name>" is the tool result of a skill that expanded; an
  // unavailable skill reports its resolution error instead.
  return { text: JSON.stringify(turn).includes("Launching skill:") ? SKILL_RAN : SKILL_MISSING };
}

/** The skills the server offered in one model request, as listed in its reminder. */
function skillListing(request) {
  const text = (request?.messages ?? [])
    .map((message) => typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((block) => block.text ?? "").join("\n"))
    .join("\n");
  const listing = /The following skills are available for use with the Skill tool:\n([\s\S]*?)\n<\/system-reminder>/.exec(text);
  return (listing?.[1] ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "));
}

/** The listing drops descriptions once the budget is tight, so match the name alone. */
function listsSkill(request, name) {
  return skillListing(request).some((line) => line === `- ${name}` || line.startsWith(`- ${name}:`));
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

function startAmber(runDirectory, port, home) {
  const child = spawn(process.execPath, [join(repositoryRoot, "dist", "src", "server.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      DATA_DIR: join(runDirectory, `data-${port}`),
      PORT: String(port),
      HOST: "127.0.0.1",
      AMBER_NO_BROWSER: "1",
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

async function startAmberReady(runDirectory, port, home) {
  const amber = startAmber(runDirectory, port, home);
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

/** Runs a /plugin command and returns the body it rendered into the transcript. */
async function pluginCommand(amber, sessionId, argument) {
  const command = `/plugin${argument ? ` ${argument}` : ""}`;
  const result = await postJson(amberUrl(amber.port, `/api/sessions/${sessionId}/commands`), { command });
  if (result.status !== 200) throw new Error(`${command} failed: ${JSON.stringify(result)}`);
  const rendered = result.body.session.messages.at(-1);
  if (rendered?.kind !== "command" || rendered.role !== "assistant") {
    throw new Error(`${command} did not append a command response: ${JSON.stringify(rendered)}`);
  }
  return rendered.content;
}

/** Sends one message and returns the session snapshot plus the model requests it made. */
async function runTurn(mock, amber, sessionId, content) {
  mock.reset();
  const response = await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`message stream failed: ${await response.text()}`);
  await readStream(response, () => undefined);
  const snapshot = await (await fetch(amberUrl(amber.port, `/api/sessions/${sessionId}`))).json();
  return { snapshot, requests: mock.requests() };
}

async function main() {
  const runDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-e2e-"));
  const home = join(runDirectory, "home");
  const workspace = join(runDirectory, "workspace");
  await mkdir(join(home, ".amber"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  // The only thing this profile carries is a provider: no marketplaces, no
  // plugins, no skills anywhere on disk.
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

  const mock = createMockProvider();
  await mock.listen(basePort + 1);
  const amber = await startAmberReady(runDirectory, basePort, home);

  try {
    const { body } = await postJson(amberUrl(amber.port, "/api/sessions"), {
      name: "plugin end to end",
      path: workspace,
    });
    const sessionId = body.session.id;

    console.log("\n== a clean profile has nothing installed");
    const emptyOverview = await pluginCommand(amber, sessionId, "");
    check("no marketplaces are added", emptyOverview.includes("No marketplaces added."), emptyOverview);
    const emptyInstalled = await pluginCommand(amber, sessionId, "installed");
    check("no plugins are installed", emptyInstalled.includes("No plugins installed."), emptyInstalled);
    check("the profile has no plugins directory yet",
      !(await pathExists(join(home, ".amber", "plugins"))));

    console.log(`\n== add ${MARKETPLACE_SPEC} from GitHub`);
    const added = await pluginCommand(amber, sessionId, `marketplace add ${MARKETPLACE_SPEC}`);
    check(`the marketplace is added as ${MARKETPLACE}`,
      added.includes(`Added marketplace **${MARKETPLACE}**`), added.split("\n")[0]);
    check("its published plugins are listed", /published plugin\(s\)/.test(added), added.split("\n")[0]);
    check("superpowers is published and not installed",
      new RegExp(`- \\*\\*${PLUGIN}\\*\\*.*_\\(not installed\\)_`).test(added),
      added.split("\n").find((line) => line.includes(`**${PLUGIN}**`)) ?? "");
    const marketplaces = JSON.parse(await readFile(join(home, ".amber", "plugins", "marketplaces.json"), "utf8"));
    check("the marketplace registry records the fetched commit",
      /^[0-9a-f]{40}$/.test(marketplaces.marketplaces[MARKETPLACE]?.commitSha ?? ""),
      JSON.stringify(marketplaces.marketplaces[MARKETPLACE]));

    console.log("\n== install is confirmed before anything is fetched");
    const plan = await pluginCommand(amber, sessionId, `install ${PLUGIN}`);
    check("the plan names the source and the resolved commit",
      plan.includes(`**Install \`${PLUGIN_KEY}\`?**`) && /- Commit: `[0-9a-f]{40}`/.test(plan), plan);
    check("the plan states that plugin skills run with the user's privileges",
      plan.includes("A plugin's skills run shell commands with your privileges."), plan);
    check("nothing was installed without confirmation",
      !(await pathExists(join(home, ".amber", "plugins", "cache"))));

    console.log("\n== install superpowers");
    const installed = await pluginCommand(amber, sessionId, `install ${PLUGIN} --yes`);
    check("the install reports the version and commit it recorded",
      installed.includes(`Installed **${PLUGIN_KEY}**`) && /- Commit: `[0-9a-f]{40}`/.test(installed), installed);
    const registry = JSON.parse(await readFile(join(home, ".amber", "plugins", "installed_plugins.json"), "utf8"));
    const record = registry.plugins[PLUGIN_KEY]?.[0];
    check("the registry record carries marketplace, version and commit sha",
      record?.marketplace === MARKETPLACE && Boolean(record.version) && /^[0-9a-f]{40}$/.test(record.commitSha ?? ""),
      JSON.stringify(record));
    const bundle = join(home, ".amber", "plugins", record?.path ?? "");
    check("the cache holds the bundle at the recorded path",
      await pathExists(join(bundle, "skills")), bundle);
    check("the installed listing shows it as enabled",
      (await pluginCommand(amber, sessionId, "installed")).includes(`**${PLUGIN_KEY}** \`${record?.version}\``));

    console.log("\n== a session lists and runs a superpowers skill");
    const enabled = await runTurn(mock, amber, sessionId, `${TURN_MARKER}: use the brainstorming skill.`);
    check("the skill listing offers the namespaced skill",
      listsSkill(enabled.requests[0], SKILL), skillListing(enabled.requests[0]).join(" | "));
    const skillCall = enabled.snapshot.session.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.name === "Skill");
    check("the Skill tool loaded the plugin skill",
      skillCall?.status === "complete" && skillCall.statusDisplay?.text === "SKILL LOADED",
      JSON.stringify(skillCall));
    const skillMessage = enabled.snapshot.session.messages.find((message) => message.kind === "skill");
    check("the skill's own instructions were injected into the session",
      skillMessage?.skillName === SKILL && skillMessage.content.length > 200,
      JSON.stringify({ name: skillMessage?.skillName, length: skillMessage?.content.length }));
    check("the turn completed on the skill's instructions",
      enabled.snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content === SKILL_RAN,
      enabled.snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content);
    check("the run ended cleanly", enabled.snapshot.active === false);

    console.log("\n== disabling the plugin takes its skills away");
    const disabled = await pluginCommand(amber, sessionId, `disable ${PLUGIN}`);
    check("the toggle reports where it was written",
      disabled.includes(`Disabled **${PLUGIN_KEY}**`) && disabled.includes("settings.toml"), disabled);
    const settingsSource = await readFile(join(home, ".amber", "settings.toml"), "utf8");
    check("settings.toml records the disabled plugin and keeps the provider",
      settingsSource.includes("[enabled_plugins]")
        && settingsSource.includes(`"${PLUGIN_KEY}" = false`)
        && settingsSource.includes("[providers.mock]"),
      settingsSource);
    const off = await runTurn(mock, amber, sessionId, `${TURN_MARKER}: use the brainstorming skill again.`);
    check("the disabled plugin's skill is gone from the listing",
      !listsSkill(off.requests[0], SKILL), skillListing(off.requests[0]).join(" | "));
    check("invoking it now fails instead of loading a stale bundle",
      off.snapshot.session.messages.flatMap((message) => message.toolCalls ?? [])
        .filter((call) => call.name === "Skill").at(-1)?.status === "error");
    check("the model was told the skill is unavailable",
      off.snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content === SKILL_MISSING);
    check("the plugin stays installed while disabled",
      (await pluginCommand(amber, sessionId, "installed")).includes("_(disabled)_"));

    console.log("\n== re-enabling restores it");
    await pluginCommand(amber, sessionId, `enable ${PLUGIN}`);
    const back = await runTurn(mock, amber, sessionId, `${TURN_MARKER}: use the brainstorming skill once more.`);
    check("the skill is listed again",
      listsSkill(back.requests[0], SKILL), skillListing(back.requests[0]).join(" | "));
    check("the skill runs again under the same namespace",
      back.snapshot.session.messages.filter((message) => message.kind === "skill" && message.skillName === SKILL).length === 2
        && back.snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content === SKILL_RAN,
      back.snapshot.session.messages.filter((message) => message.role === "assistant").at(-1)?.content);

    console.log("\n== update reports the installed plugin as current");
    const updates = await pluginCommand(amber, sessionId, "update");
    check("the freshly installed plugin is up to date",
      new RegExp(`\\*\\*${PLUGIN_KEY}\\*\\*.*up to date`).test(updates), updates);

    console.log("\n== uninstall leaves no trace");
    const removed = await pluginCommand(amber, sessionId, `uninstall ${PLUGIN}`);
    check("uninstall reports the removal", removed.includes(`Uninstalled **${PLUGIN_KEY}**`), removed);
    check("the cached bundle is gone", !(await pathExists(bundle)));
    const afterRemoval = JSON.parse(await readFile(join(home, ".amber", "plugins", "installed_plugins.json"), "utf8"));
    check("the registry record is gone", afterRemoval.plugins[PLUGIN_KEY] === undefined,
      JSON.stringify(afterRemoval.plugins));
  } finally {
    console.log(`\namber log:\n${amber.log()}`);
    await amber.stop();
    mock.close();
    await rm(runDirectory, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
