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
  assert.match(source, /^theme = "dark" # dark \(current Amber\), light \(Solarized Light\), light\+ \(VS Code Light\+\), or hacker \(terminal green\)$/m);
  assert.match(source, /^# default_agent_provider = ""$/m);
  assert.match(source, /^# default_agent_model = ""$/m);
  assert.match(source, /# model = "<INSERT_AGENT_PROVIDER_SLASH_MODEL_HERE>"/);
  assert.doesNotMatch(source, /INSERT_AGENT_AUTH/);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("loads an existing settings file without replacing it", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  const expected = {
    theme: "dark",
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
    theme: "dark",
    providers: {
      zai: { api: "anthropic", auth_key: "saved-key", auth_url: "https://example.test", models: {} },
    },
    agents: [],
  });
});

test("loads optional default agent provider and model", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    default_agent_provider: " openai ",
    default_agent_model: " gpt-agent ",
    providers: {
      zai: { auth_key: "zai-key", auth_url: "https://zai.example.test", models: {} },
      openai: { api: "openai", auth_key: "openai-key", auth_url: "https://openai.example.test", models: {} },
    },
  }), "utf8");

  const settings = await loadSettings(homeDirectory);
  assert.equal(settings.default_agent_provider, "openai");
  assert.equal(settings.default_agent_model, "gpt-agent");
});

test("validates default agent provider and model", async () => {
  const writeSettings = async (settings: object): Promise<string> => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
    const settingsDirectory = join(homeDirectory, ".amber");
    await mkdir(settingsDirectory);
    await writeFile(join(settingsDirectory, "settings.toml"), stringify(settings), "utf8");
    return homeDirectory;
  };
  const providers = {
    zai: { auth_key: "key", auth_url: "https://example.test", models: {} },
  };

  await assert.rejects(
    loadSettings(await writeSettings({ default_agent_provider: "missing", providers })),
    /default_agent_provider 'missing' is not configured/,
  );
  await assert.rejects(
    loadSettings(await writeSettings({ default_agent_model: "agent-model", providers })),
    /default_agent_model requires default_agent_provider/,
  );
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
    theme: "dark",
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

test("loads each supported color theme", async () => {
  for (const theme of ["dark", "light", "light+", "hacker"] as const) {
    const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
    const settingsDirectory = join(homeDirectory, ".amber");
    await mkdir(settingsDirectory);
    await writeFile(join(settingsDirectory, "settings.toml"), stringify({
      theme,
      providers: {
        test: { auth_key: "key", auth_url: "https://example.test" },
      },
    }), "utf8");

    assert.equal((await loadSettings(homeDirectory)).theme, theme);
  }
});

test("rejects an unsupported color theme", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    theme: "sepia",
    providers: {
      test: { auth_key: "key", auth_url: "https://example.test" },
    },
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /theme must be dark, light, light\+, or hacker/);
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
        models: { "gpt-test": { thinking_level: "none" }, "xiaomi/mimo-v2-pro": {} },
      },
    },
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).providers.openai, {
    api: "openai",
    auth_key: "openai-key",
    auth_url: "https://api.openai.com/v1",
    thinking_level: "xhigh",
    models: { "gpt-test": { thinking_level: "none" }, "xiaomi/mimo-v2-pro": {} },
  });
});

test("loads an OpenAI Codex OAuth provider without an API key", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    default_provider: "openai-codex",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        default_model: "gpt-codex",
        thinking_level: "high",
      },
    },
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).providers["openai-codex"], {
    api: "openai",
    auth: "openai-codex",
    auth_url: "https://chatgpt.com/backend-api",
    default_model: "gpt-codex",
    thinking_level: "high",
    models: {},
  });
});

test("rejects OpenAI Codex OAuth providers without a usable fallback model", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: { "openai-codex": { api: "openai", auth: "openai-codex" } },
  }), "utf8");

  await assert.rejects(
    loadSettings(homeDirectory),
    /openai-codex auth requires default_model or at least one explicit model/,
  );
});

test("rejects OpenAI Codex OAuth on non-OpenAI providers", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: { codex: { api: "anthropic", auth: "openai-codex", default_model: "gpt-test" } },
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /openai-codex auth requires api = "openai"/);
});

test("rejects slashed model names for anthropic providers", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "key",
        auth_url: "https://example.test",
        models: { "glm/5.3": {} },
      },
    },
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /providers\.zai\.models model names cannot contain/);
});
