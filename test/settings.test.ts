import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  loadSettings,
  loadSettingsSource,
  parseSettingsSource,
  saveSettingsSource,
  settingsForEditor,
  settingsSourceFromEditor,
} from "../src/settings.js";
import { COMMIT_SKILL_TEMPLATE_SOURCE, SETTINGS_TEMPLATE, SETTINGS_TEMPLATE_SOURCE } from "../src/settings-template.js";

test("creates a settings template on first load", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));

  const settings = await loadSettings(homeDirectory);
  const settingsPath = join(homeDirectory, ".amber", "settings.toml");
  const source = await readFile(settingsPath, "utf8");

  assert.deepEqual(settings, SETTINGS_TEMPLATE);
  assert.deepEqual(parse(source), SETTINGS_TEMPLATE);
  assert.match(source, /^theme = "light\+" # dark \(current Amber\), light \(Solarized Light\), light\+ \(VS Code Light\+\), or hacker \(terminal green\)$/m);
  assert.match(source, /^# default_agent_provider = ""$/m);
  assert.match(source, /^# default_agent_model = ""$/m);
  assert.match(source, /# model = "<INSERT_AGENT_PROVIDER_SLASH_MODEL_HERE>"/);
  assert.match(source, /^compact = false # Set to true to enable auto-compaction of the agent's context\.$/m);
  assert.equal(source.match(/^compact = false$/gm)?.length, 1);
  assert.doesNotMatch(source, /INSERT_AGENT_AUTH/);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("loads, parses, and atomically saves the settings file", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const initial = await loadSettingsSource(homeDirectory);
  assert.equal(initial.path, join(homeDirectory, ".amber", "settings.toml"));
  assert.deepEqual(parseSettingsSource(initial.source, initial.path), SETTINGS_TEMPLATE);

  const updated = initial.source.replace('theme = "light+"', 'theme = "hacker"');
  assert.equal(await saveSettingsSource(updated, homeDirectory), initial.path);
  assert.equal((await loadSettings(homeDirectory)).theme, "hacker");
  assert.equal(await readFile(initial.path, "utf8"), updated);
  assert.equal((await stat(initial.path)).mode & 0o777, 0o600);
});

test("presents settings as a structured editor document without template placeholders", () => {
  const editor = settingsForEditor(parseSettingsSource(SETTINGS_TEMPLATE_SOURCE));

  assert.equal(editor.theme, "light+");
  assert.deepEqual(editor.providers.default, {
    api: "anthropic",
    thinking_level: "max",
    compact_tokens: 200_000,
    models: {},
  });
  assert.equal(editor.agents.length, 2);
});

test("generates canonical TOML from structured settings", () => {
  const result = settingsSourceFromEditor({
    theme: "light+",
    default_provider: "openai-codex",
    ignored: "not persisted",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        auth_url: "https://chatgpt.com/backend-api",
        default_model: "gpt-5.6-sol",
        thinking_level: "high",
        compact_tokens: 250_000,
        models: {},
        ignored: true,
      },
    },
    agents: [],
  }, "/tmp/settings.toml");

  assert.deepEqual(parse(result.source), {
    theme: "light+",
    default_provider: "openai-codex",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        default_model: "gpt-5.6-sol",
        thinking_level: "high",
        compact_tokens: 250_000,
      },
    },
    agents: [],
  });
  assert.equal(result.settings.providers["openai-codex"]?.auth_url, "https://chatgpt.com/backend-api");
  assert.doesNotMatch(result.source, /ignored|models|auth_url/);
});

test("preserves a per-agent thinking level in structured settings", () => {
  const result = settingsSourceFromEditor({
    theme: "light+",
    providers: {
      openai: { api: "openai", auth_key: "key", auth_url: "https://example.test", models: {} },
    },
    agents: [{
      type: "review",
      whenToUse: "Review code.",
      systemPrompt: "Review it.",
      readOnly: true,
      thinking_level: "high",
    }],
  }, "/tmp/settings.toml");

  assert.equal(result.settings.agents[0]?.thinking_level, "high");
  assert.equal((parse(result.source).agents as Array<Record<string, unknown>>)[0]?.thinking_level, "high");
});

test("rejects invalid structured settings before generating a usable document", () => {
  assert.throws(() => settingsSourceFromEditor({
    theme: "light+",
    providers: {
      broken: { api: "openai", auth_key: "", auth_url: "", models: {} },
    },
    agents: [],
  }, "/tmp/settings.toml"), /providers\.broken\.auth_key must be a non-empty string/);
});

test("seeds the commit skill when settings are first created", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));

  await loadSettings(homeDirectory);
  const skillPath = join(homeDirectory, ".amber", "skills", "commit", "SKILL.md");

  assert.equal(await readFile(skillPath, "utf8"), COMMIT_SKILL_TEMPLATE_SOURCE);
  assert.equal((await stat(skillPath)).mode & 0o777, 0o600);
});

test("seeds the commit skill only when settings.toml does not exist", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const skillDirectory = join(settingsDirectory, "skills", "commit");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "custom skill", "utf8");
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: { zai: { auth_key: "key", auth_url: "https://example.test" } },
  }), "utf8");

  await loadSettings(homeDirectory);

  assert.equal(await readFile(join(skillDirectory, "SKILL.md"), "utf8"), "custom skill");
});

test("does not overwrite an existing commit skill when seeding settings", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const skillDirectory = join(homeDirectory, ".amber", "skills", "commit");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "custom skill", "utf8");

  await loadSettings(homeDirectory);

  assert.equal(await readFile(join(skillDirectory, "SKILL.md"), "utf8"), "custom skill");
  assert.deepEqual(
    parse(await readFile(join(homeDirectory, ".amber", "settings.toml"), "utf8")),
    SETTINGS_TEMPLATE,
  );
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
    theme: "light+",
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

test("loads and validates a per-agent thinking level", () => {
  const base = {
    providers: {
      openai: { api: "openai", auth_key: "key", auth_url: "https://example.test", models: {} },
    },
    agents: [{
      type: "review",
      whenToUse: "Review code.",
      systemPrompt: "Review it.",
      readOnly: true,
      thinking_level: "xhigh",
    }],
  };

  assert.equal(parseSettingsSource(stringify(base), "/tmp/settings.toml").agents[0]?.thinking_level, "xhigh");
  assert.throws(
    () => parseSettingsSource(stringify({
      ...base,
      agents: [{ ...base.agents[0], thinking_level: "extreme" }],
    }), "/tmp/settings.toml"),
    /agents\[0\]\.thinking_level must be none, low, medium, high, xhigh, or max/,
  );
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

test("loads an optional compaction flag for each agent", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: { auth_key: "saved-key", auth_url: "https://example.test", models: {} },
    },
    agents: [
      { type: "compacting", whenToUse: "Search.", systemPrompt: "Search it.", readOnly: false, compact: true },
      { type: "plain", whenToUse: "Review.", systemPrompt: "Review it.", readOnly: true },
    ],
  }), "utf8");

  const agents = (await loadSettings(homeDirectory)).agents;
  assert.deepEqual(agents[0], {
    type: "compacting",
    whenToUse: "Search.",
    systemPrompt: "Search it.",
    readOnly: false,
    compact: true,
  });
  assert.equal("compact" in agents[1]!, false);
});

test("rejects a non-boolean agent compaction flag", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      zai: { auth_key: "key", auth_url: "https://example.test", models: {} },
    },
    agents: [{
      type: "compacting",
      whenToUse: "Search.",
      systemPrompt: "Search it.",
      readOnly: false,
      compact: "yes",
    }],
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /agents\[0\]\.compact must be a boolean/);
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
    theme: "light+",
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
        thinking_level: "high",
      },
    },
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).providers["openai-codex"], {
    api: "openai",
    auth: "openai-codex",
    auth_url: "https://chatgpt.com/backend-api",
    thinking_level: "high",
    models: {},
  });
});

test("rejects multiple OpenAI Codex OAuth providers", () => {
  const multipleCodexProviders = {
    default_provider: "openai-codex-2",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        default_model: "gpt-primary",
      },
      "openai-codex-2": {
        api: "openai",
        auth: "openai-codex",
        default_model: "gpt-secondary",
      },
    },
  };

  assert.equal(
    Object.keys(parseSettingsSource(stringify(multipleCodexProviders), "/tmp/settings.toml").providers).length,
    2,
    "raw settings remain readable so the modal can remove the extra provider",
  );
  assert.throws(
    () => settingsSourceFromEditor(multipleCodexProviders, "/tmp/settings.toml"),
    /configure at most one provider with auth = "openai-codex"/,
  );
});

test("allows an OpenAI Codex OAuth provider to omit its default model before login", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: { "openai-codex": { api: "openai", auth: "openai-codex" } },
  }), "utf8");

  assert.deepEqual((await loadSettings(homeDirectory)).providers["openai-codex"], {
    api: "openai",
    auth: "openai-codex",
    auth_url: "https://chatgpt.com/backend-api",
    models: {},
  });
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

test("treats API keys and OpenAI Codex as mutually exclusive auth modes", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.toml"), stringify({
    providers: {
      codex: {
        api: "openai",
        auth: "openai-codex",
        auth_key: "not-used",
        default_model: "gpt-test",
      },
    },
  }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /use auth or auth_key, not both/);
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
