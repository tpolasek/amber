import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { loadSettings, SETTINGS_TEMPLATE } from "../src/settings.js";

test("creates a settings template on first load", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));

  const settings = await loadSettings(homeDirectory);
  const settingsPath = join(homeDirectory, ".amber", "settings.toml");
  const source = await readFile(settingsPath, "utf8");

  assert.deepEqual(settings, SETTINGS_TEMPLATE);
  assert.deepEqual(parse(source), SETTINGS_TEMPLATE);
  assert.match(source, /# model = "<INSERT_AGENT_MODEL_HERE>"/);
  assert.match(source, /# auth_key = "<INSERT_AGENT_AUTH_KEY_HERE>"/);
  assert.match(source, /# auth_url = "<INSERT_AGENT_AUTH_URL_HERE>"/);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("loads an existing settings file without replacing it", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  const expected = {
    auth_key: "saved-key",
    auth_url: "https://example.test/anthropic",
    default_model: "saved-model",
    agents: structuredClone(SETTINGS_TEMPLATE.agents),
  };
  await mkdir(settingsDirectory);
  const source = stringify(expected);
  await writeFile(settingsPath, source, "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), expected);
  assert.equal(await readFile(settingsPath, "utf8"), source);
});

test("loads settings with no configured agents", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    auth_key: "saved-key",
    default_model: "saved-model",
  }), "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), {
    auth_key: "saved-key",
    default_model: "saved-model",
    agents: [],
  });
});

test("loads optional provider settings for each agent", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    agents: [{
      type: "review",
      whenToUse: "Review code.",
      systemPrompt: "Review it.",
      readOnly: true,
      model: " agent-model ",
      auth_key: " agent-token ",
      auth_url: " https://agent.example.test/anthropic ",
    }],
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).agents[0], {
    type: "review",
    whenToUse: "Review code.",
    systemPrompt: "Review it.",
    readOnly: true,
    model: "agent-model",
    auth_key: "agent-token",
    auth_url: "https://agent.example.test/anthropic",
  });
});

test("reports invalid settings fields", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), "default_model = 42\n", "utf8");

  await assert.rejects(loadSettings(homeDirectory), /default_model must be a string/);
});

test("validates configured agent definitions", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    agents: [
      { type: "duplicate", whenToUse: "First.", systemPrompt: "First prompt.", readOnly: false },
      { type: "duplicate", whenToUse: "Second.", systemPrompt: "Second prompt.", readOnly: true },
    ],
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /agent types must be unique/);
});

test("does not migrate legacy JSON settings", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const legacyPath = join(settingsDirectory, "settings.json");
  await mkdir(settingsDirectory);
  await writeFile(legacyPath, JSON.stringify({ auth_key: "legacy-key", default_model: "legacy-model" }), "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), SETTINGS_TEMPLATE);
  assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).auth_key, "legacy-key");
  assert.deepEqual(parse(await readFile(join(settingsDirectory, "settings.toml"), "utf8")), SETTINGS_TEMPLATE);
});
