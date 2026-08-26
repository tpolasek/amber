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
  assert.doesNotMatch(source, /INSERT_AGENT_AUTH/);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("loads an existing settings file without replacing it", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  const expected = {
    default_provider: "zai",
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "saved-key",
        auth_url: "https://example.test/anthropic",
        default_model: "glm-5.3",
        thinking_level: "max",
        compact_tokens: 200_000,
        models: {
          "glm-5.3": { compact_tokens: 100_000 },
        },
      },
    },
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
    providers: {
      zai: { api: "anthropic", auth_key: "saved-key", auth_url: "https://example.test", models: {} },
    },
  }), "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), {
    providers: {
      zai: { api: "anthropic", auth_key: "saved-key", auth_url: "https://example.test", models: {} },
    },
    agents: [],
  });
});

test("loads a qualified provider model for each agent", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: { auth_key: "saved-key", auth_url: "https://example.test", models: {} },
    },
    agents: [{
      type: "review",
      whenToUse: "Review code.",
      systemPrompt: "Review it.",
      readOnly: true,
      model: " zai/agent-model ",
    }],
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).agents[0], {
    type: "review",
    whenToUse: "Review code.",
    systemPrompt: "Review it.",
    readOnly: true,
    model: "zai/agent-model",
  });
});

test("reports invalid settings fields", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: { auth_key: "key", auth_url: "https://example.test", compact_tokens: -1 },
    },
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /compact_tokens must be a positive integer/);
});

test("validates configured agent definitions", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: { auth_key: "key", auth_url: "https://example.test" },
    },
    agents: [
      { type: "duplicate", whenToUse: "First.", systemPrompt: "First prompt.", readOnly: false },
      { type: "duplicate", whenToUse: "Second.", systemPrompt: "Second prompt.", readOnly: true },
    ],
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /agent types must be unique/);
});

test("rejects per-agent credentials", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: { zai: { auth_key: "key", auth_url: "https://example.test" } },
    agents: [{
      type: "review",
      whenToUse: "Review code.",
      systemPrompt: "Review it.",
      readOnly: true,
      auth_key: "agent-key",
    }],
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /must use model = "provider\/model"/);
});

test("accepts legacy top-level provider settings", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    auth_key: "legacy-key",
    auth_url: "https://legacy.test",
    default_model: "legacy-model",
  }), "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), {
    providers: {
      default: {
        api: "anthropic",
        auth_key: "legacy-key",
        auth_url: "https://legacy.test",
        default_model: "legacy-model",
        models: { "legacy-model": {} },
      },
    },
    agents: [],
  });
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

test("loads OpenAI providers and extended reasoning levels", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      openai: {
        api: "openai",
        auth_key: "openai-key",
        auth_url: "https://api.openai.com/v1",
        thinking_level: "xhigh",
        models: { "gpt-test": { thinking_level: "none" } },
      },
    },
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).providers.openai, {
    api: "openai",
    auth_key: "openai-key",
    auth_url: "https://api.openai.com/v1",
    thinking_level: "xhigh",
    models: { "gpt-test": { thinking_level: "none" } },
  });
});
