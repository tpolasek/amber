import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, SETTINGS_TEMPLATE } from "../src/settings.js";

test("creates a settings template on first load", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));

  const settings = await loadSettings(homeDirectory);
  const settingsPath = join(homeDirectory, ".amber", "settings.json");

  assert.deepEqual(settings, SETTINGS_TEMPLATE);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), SETTINGS_TEMPLATE);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("loads an existing settings file without replacing it", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.json");
  const expected = {
    auth_key: "saved-key",
    auth_url: "https://example.test/anthropic",
    default_model: "saved-model",
  };
  await mkdir(settingsDirectory);
  await writeFile(settingsPath, `${JSON.stringify(expected)}\n`, "utf8");

  assert.deepEqual(await loadSettings(homeDirectory), expected);
  assert.equal(await readFile(settingsPath, "utf8"), `${JSON.stringify(expected)}\n`);
});

test("reports invalid settings fields", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-settings-"));
  const settingsDirectory = join(homeDirectory, ".amber");
  await mkdir(settingsDirectory);
  await writeFile(join(settingsDirectory, "settings.json"), JSON.stringify({ default_model: 42 }), "utf8");

  await assert.rejects(loadSettings(homeDirectory), /default_model must be a string/);
});
