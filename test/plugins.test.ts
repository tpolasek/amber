import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  addMarketplace,
  loadMarketplaceRegistry,
  listMarketplacePlugins,
  marketplaceCheckoutPath,
  parseMarketplaceManifest,
  parseMarketplaceSpec,
  parsePluginCommand,
  pluginsDirectory,
  removeMarketplace,
  renderMarketplaceList,
  renderPluginList,
  saveMarketplaceRegistry,
} from "../src/plugins.js";

const run = promisify(execFile);

async function marketplaceFixture(plugins: unknown[], directoryName = ".claude-plugin"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amber-marketplace-"));
  await mkdir(join(root, directoryName), { recursive: true });
  await writeFile(
    join(root, directoryName, "marketplace.json"),
    JSON.stringify({ name: "fixture", description: "A fixture", plugins }),
  );
  return root;
}

async function gitMarketplaceFixture(plugins: unknown[]): Promise<{ path: string; sha: string }> {
  const root = await marketplaceFixture(plugins);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "fixture"], { cwd: root });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  return { path: root, sha: stdout.trim() };
}

/* ------------------------------------------------------------------ */
/* Spec parsing                                                        */
/* ------------------------------------------------------------------ */

test("parses marketplace specs into sources", () => {
  assert.deepEqual(parseMarketplaceSpec("anthropics/claude-plugins-official"), {
    type: "url",
    url: "https://github.com/anthropics/claude-plugins-official.git",
  });
  assert.deepEqual(parseMarketplaceSpec("https://github.com/acme/mp.git"), {
    type: "url",
    url: "https://github.com/acme/mp.git",
  });
  assert.deepEqual(parseMarketplaceSpec("git@github.com:acme/mp.git"), {
    type: "url",
    url: "git@github.com:acme/mp.git",
  });
  assert.deepEqual(parseMarketplaceSpec("anthropics/claude-plugins-official@next"), {
    type: "url",
    url: "https://github.com/anthropics/claude-plugins-official.git",
    ref: "next",
  });
  assert.deepEqual(parseMarketplaceSpec("./local/mp"), { type: "directory", path: "./local/mp" });
  assert.deepEqual(parseMarketplaceSpec("/srv/mp"), { type: "directory", path: "/srv/mp" });
  assert.throws(() => parseMarketplaceSpec("  "), /non-empty/);
});

/* ------------------------------------------------------------------ */
/* Manifest parsing                                                    */
/* ------------------------------------------------------------------ */

test("parses a Claude Code marketplace manifest unchanged", () => {
  const manifest = parseMarketplaceManifest({
    $schema: "https://example.com/schema.json",
    name: "claude-plugins-official",
    description: "Official plugins",
    owner: { name: "Anthropic", email: "support@anthropic.com" },
    renames: { old: "new" },
    plugins: [
      {
        name: "superpowers",
        description: "Skills",
        source: { source: "url", url: "https://github.com/obra/superpowers.git", sha: "b36e0829" },
        category: "workflow",
        author: { name: "obra" },
        strict: false,
      },
      {
        name: "mono-plugin",
        description: "From a subdirectory",
        source: { source: "git-subdir", url: "https://github.com/acme/mono.git", path: "plugins/foo", ref: "v2.1.0" },
      },
      { name: "local-plugin", description: "Bare string source", source: "./plugins/local" },
      { name: "gh-plugin", description: "Github form", source: { source: "github", repo: "acme/gh" } },
    ],
  }, "/tmp/marketplace.json");

  assert.equal(manifest.name, "claude-plugins-official");
  assert.equal(manifest.description, "Official plugins");
  assert.equal(manifest.owner, "Anthropic");
  assert.deepEqual(manifest.plugins.map((plugin) => plugin.source), [
    { type: "url", url: "https://github.com/obra/superpowers.git", sha: "b36e0829" },
    { type: "git-subdir", url: "https://github.com/acme/mono.git", path: "plugins/foo", ref: "v2.1.0" },
    { type: "directory", path: "./plugins/local" },
    { type: "url", url: "https://github.com/acme/gh.git" },
  ]);
  assert.equal(manifest.plugins[0]?.author, "obra");
  assert.equal(manifest.plugins[0]?.category, "workflow");
});

test("accepts Amber's own `type` discriminator and an empty plugin list", () => {
  const manifest = parseMarketplaceManifest({
    name: "amber-native",
    plugins: [{ name: "a", description: "d", source: { type: "url", url: "https://example.com/a.git" } }],
  }, "/tmp/m.json");
  assert.deepEqual(manifest.plugins[0]?.source, { type: "url", url: "https://example.com/a.git" });
  assert.deepEqual(parseMarketplaceManifest({ name: "empty", plugins: [] }, "/tmp/m.json").plugins, []);
});

test("rejects malformed marketplace manifests", () => {
  assert.throws(() => parseMarketplaceManifest(null, "/tmp/m.json"), /must contain a JSON object/);
  assert.throws(() => parseMarketplaceManifest({ plugins: [] }, "/tmp/m.json"), /name must match/);
  assert.throws(() => parseMarketplaceManifest({ name: "Bad Name", plugins: [] }, "/tmp/m.json"), /name must match/);
  assert.throws(() => parseMarketplaceManifest({ name: "ok" }, "/tmp/m.json"), /plugins must be an array/);
  assert.throws(
    () => parseMarketplaceManifest({ name: "ok", plugins: [{ name: "a", description: "d" }] }, "/tmp/m.json"),
    /plugins\[0\].source is required/,
  );
  assert.throws(
    () => parseMarketplaceManifest({
      name: "ok",
      plugins: [
        { name: "dup", description: "d", source: "./a" },
        { name: "dup", description: "d", source: "./b" },
      ],
    }, "/tmp/m.json"),
    /duplicate plugin name/,
  );
  assert.throws(
    () => parseMarketplaceManifest({
      name: "ok",
      plugins: [{ name: "a", description: "d", source: { source: "git-subdir", url: "https://x/y.git" } }],
    }, "/tmp/m.json"),
    /path must be/,
  );
});

/* ------------------------------------------------------------------ */
/* Command parsing                                                     */
/* ------------------------------------------------------------------ */

test("parses /plugin subcommands", () => {
  assert.deepEqual(parsePluginCommand(""), { kind: "overview" });
  assert.deepEqual(parsePluginCommand("marketplace list"), { kind: "marketplace-list" });
  assert.deepEqual(parsePluginCommand("marketplaces"), { kind: "marketplace-list" });
  assert.deepEqual(parsePluginCommand("marketplace add anthropics/claude-plugins-official"), {
    kind: "marketplace-add",
    spec: "anthropics/claude-plugins-official",
  });
  assert.deepEqual(parsePluginCommand("marketplace add ./mp as local"), {
    kind: "marketplace-add",
    spec: "./mp",
    alias: "local",
  });
  assert.deepEqual(parsePluginCommand("marketplace remove local"), { kind: "marketplace-remove", name: "local" });
  assert.deepEqual(parsePluginCommand("list"), { kind: "list" });
  assert.deepEqual(parsePluginCommand("list fixture"), { kind: "list", marketplace: "fixture" });
  assert.match((parsePluginCommand("marketplace add") as { message: string }).message, /Usage/);
  assert.match((parsePluginCommand("frobnicate") as { message: string }).message, /Unknown/);
});

/* ------------------------------------------------------------------ */
/* Registry persistence                                                */
/* ------------------------------------------------------------------ */

test("reads a missing registry as empty and saves it atomically with tight modes", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  assert.deepEqual(await loadMarketplaceRegistry(homeDirectory), { version: 1, marketplaces: {} });

  const registry = {
    version: 1 as const,
    marketplaces: {
      fixture: {
        source: { type: "url" as const, url: "https://example.com/mp.git" },
        addedAt: "2026-09-12T00:00:00.000Z",
        lastFetchedAt: "2026-09-12T00:00:00.000Z",
        commitSha: "abc123",
      },
    },
  };
  const path = await saveMarketplaceRegistry(registry, homeDirectory);
  assert.equal(path, join(pluginsDirectory(homeDirectory), "marketplaces.json"));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(pluginsDirectory(homeDirectory))).mode & 0o777, 0o700);
  assert.deepEqual(await loadMarketplaceRegistry(homeDirectory), registry);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), registry);
});

/* ------------------------------------------------------------------ */
/* Add, list, remove                                                   */
/* ------------------------------------------------------------------ */

test("adds a directory marketplace and lists its published plugins", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const source = await marketplaceFixture([
    { name: "superpowers", description: "Skills for agents", source: { source: "url", url: "https://github.com/obra/superpowers.git" } },
  ]);

  const added = await addMarketplace({ spec: source, homeDirectory });
  assert.equal(added.name, "fixture");
  assert.equal(added.manifest.plugins.length, 1);

  const listed = await listMarketplacePlugins({ homeDirectory });
  assert.deepEqual(listed.map((entry) => [entry.marketplace, entry.plugin.name, entry.installed]), [
    ["fixture", "superpowers", false],
  ]);

  const registry = await loadMarketplaceRegistry(homeDirectory);
  assert.deepEqual(registry.marketplaces.fixture?.source, { type: "directory", path: source });
  assert.equal(registry.marketplaces.fixture?.commitSha, undefined);
  assert.equal((await stat(marketplaceCheckoutPath("fixture", homeDirectory))).isDirectory(), true);
});

test("prefers an .amber-plugin manifest over the Claude-compatible one", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const source = await marketplaceFixture([{ name: "claude-one", description: "d", source: "./a" }]);
  await mkdir(join(source, ".amber-plugin"), { recursive: true });
  await writeFile(
    join(source, ".amber-plugin", "marketplace.json"),
    JSON.stringify({ name: "fixture", plugins: [{ name: "amber-one", description: "d", source: "./a" }] }),
  );

  const added = await addMarketplace({ spec: source, homeDirectory });
  assert.deepEqual(added.manifest.plugins.map((plugin) => plugin.name), ["amber-one"]);
});

test("clones a git marketplace and records its resolved commit sha", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const origin = await gitMarketplaceFixture([
    { name: "superpowers", description: "Skills for agents", source: "./plugins/superpowers" },
  ]);

  const added = await addMarketplace({ spec: origin.path, homeDirectory, treatDirectoryAsGit: true });
  assert.equal(added.record.commitSha, origin.sha);
  assert.equal(added.record.source.type, "url");

  const checkout = marketplaceCheckoutPath("fixture", homeDirectory);
  assert.equal((await stat(join(checkout, ".claude-plugin", "marketplace.json"))).isFile(), true);
  const listed = await listMarketplacePlugins({ homeDirectory });
  assert.deepEqual(listed.map((entry) => entry.plugin.name), ["superpowers"]);
});

test("names a marketplace by its alias and rejects a duplicate name", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const source = await marketplaceFixture([{ name: "a", description: "d", source: "./a" }]);

  const added = await addMarketplace({ spec: source, alias: "mine", homeDirectory });
  assert.equal(added.name, "mine");
  await assert.rejects(addMarketplace({ spec: source, alias: "mine", homeDirectory }), /already added/);

  // The manifest's own name is still free, so adding it unaliased works.
  assert.equal((await addMarketplace({ spec: source, homeDirectory })).name, "fixture");
  assert.deepEqual(Object.keys((await loadMarketplaceRegistry(homeDirectory)).marketplaces).sort(), ["fixture", "mine"]);
});

test("refuses a source with no marketplace manifest", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const empty = await mkdtemp(join(tmpdir(), "amber-empty-"));
  await assert.rejects(addMarketplace({ spec: empty, homeDirectory }), /no \.amber-plugin\/marketplace\.json/);
  assert.deepEqual((await loadMarketplaceRegistry(homeDirectory)).marketplaces, {});
});

test("removes a marketplace and its checkout", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const source = await marketplaceFixture([{ name: "a", description: "d", source: "./a" }]);
  await addMarketplace({ spec: source, homeDirectory });

  await removeMarketplace("fixture", homeDirectory);
  assert.deepEqual((await loadMarketplaceRegistry(homeDirectory)).marketplaces, {});
  await assert.rejects(stat(marketplaceCheckoutPath("fixture", homeDirectory)));
  await assert.rejects(removeMarketplace("fixture", homeDirectory), /not added/);
  // Removing a marketplace never touches the source it was added from.
  assert.equal((await stat(join(source, ".claude-plugin", "marketplace.json"))).isFile(), true);
});

test("lists plugins for one named marketplace only", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const first = await marketplaceFixture([{ name: "one", description: "d", source: "./a" }]);
  const second = await marketplaceFixture([{ name: "two", description: "d", source: "./b" }]);
  await addMarketplace({ spec: first, alias: "first", homeDirectory });
  await addMarketplace({ spec: second, alias: "second", homeDirectory });

  const listed = await listMarketplacePlugins({ homeDirectory, marketplace: "second" });
  assert.deepEqual(listed.map((entry) => entry.plugin.name), ["two"]);
  await assert.rejects(listMarketplacePlugins({ homeDirectory, marketplace: "third" }), /not added/);
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

test("renders an empty marketplace list with the add hint", () => {
  const rendered = renderMarketplaceList({ version: 1, marketplaces: {} });
  assert.match(rendered, /No marketplaces added/);
  assert.match(rendered, /\/plugin marketplace add/);
});

test("renders marketplaces and plugins as markdown", () => {
  const rendered = renderMarketplaceList({
    version: 1,
    marketplaces: {
      fixture: {
        source: { type: "url", url: "https://github.com/acme/mp.git", ref: "main" },
        addedAt: "2026-09-12T00:00:00.000Z",
        lastFetchedAt: "2026-09-12T00:00:00.000Z",
        commitSha: "abcdef1234567890",
      },
    },
  });
  assert.match(rendered, /\*\*fixture\*\*/);
  assert.match(rendered, /https:\/\/github\.com\/acme\/mp\.git/);
  assert.match(rendered, /abcdef123456/);
  assert.doesNotMatch(rendered, /abcdef1234567890/);

  const plugins = renderPluginList([
    {
      marketplace: "fixture",
      plugin: { name: "superpowers", description: "Skills for agents", source: { type: "url", url: "https://github.com/obra/superpowers.git" } },
      installed: false,
    },
  ]);
  assert.match(plugins, /superpowers/);
  assert.match(plugins, /Skills for agents/);
  assert.match(plugins, /not installed/);
  assert.match(renderPluginList([]), /No plugins/);
});
