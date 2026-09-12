import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  addMarketplace,
  checkPluginUpdates,
  enabledPluginBundles,
  installedPluginKey,
  installPlugin,
  isPluginEnabled,
  loadInstalledPlugins,
  loadMarketplaceRegistry,
  listMarketplacePlugins,
  marketplaceCheckoutPath,
  parseMarketplaceManifest,
  parseMarketplaceSpec,
  parsePluginCommand,
  planPluginInstall,
  planPluginUpdate,
  pluginCachePath,
  pluginCacheRelativePath,
  pluginsDirectory,
  removeMarketplace,
  saveInstalledPlugins,
  renderInstalledPlugins,
  renderMarketplaceList,
  renderMarketplaceUpdate,
  renderPluginInstallPlan,
  renderPluginList,
  renderPluginUpdated,
  renderPluginUpdatePlan,
  renderPluginUpdateReport,
  saveMarketplaceRegistry,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
} from "../src/plugins.js";
import type { PluginUpdateStatus } from "../src/plugins.js";

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

/** A plugin bundle: a manifest (optional), one skill, and a file discovery ignores. */
async function bundleFixture(root: string, manifest?: Record<string, unknown>): Promise<string> {
  await mkdir(join(root, "skills", "brainstorming"), { recursive: true });
  await writeFile(join(root, "skills", "brainstorming", "SKILL.md"), "---\nname: brainstorming\n---\nBody\n");
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", "helper.md"), "helper\n");
  if (manifest) {
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  }
  return root;
}

/** A git repository serving one plugin bundle, optionally under a subdirectory. */
async function gitBundleFixture(manifest?: Record<string, unknown>, subdirectory?: string): Promise<{ path: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), "amber-bundle-"));
  const bundle = subdirectory ? join(root, subdirectory) : root;
  await mkdir(bundle, { recursive: true });
  await bundleFixture(bundle, manifest);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "bundle"], { cwd: root });
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

test("parses install and uninstall targets, scopes and confirmation", () => {
  assert.deepEqual(parsePluginCommand("installed"), { kind: "installed" });
  assert.deepEqual(parsePluginCommand("install superpowers"), {
    kind: "install", name: "superpowers", scope: "user", confirmed: false,
  });
  assert.deepEqual(parsePluginCommand("install superpowers@fixture --yes"), {
    kind: "install", name: "superpowers", marketplace: "fixture", scope: "user", confirmed: true,
  });
  assert.deepEqual(parsePluginCommand("install superpowers --project --yes"), {
    kind: "install", name: "superpowers", scope: "project", confirmed: true,
  });
  assert.deepEqual(parsePluginCommand("uninstall superpowers@fixture --project"), {
    kind: "uninstall", name: "superpowers", marketplace: "fixture", scope: "project",
  });
  assert.match((parsePluginCommand("install") as { message: string }).message, /Usage/);
  assert.match((parsePluginCommand("install a b") as { message: string }).message, /Usage/);
  assert.match((parsePluginCommand("uninstall a --yes") as { message: string }).message, /Unknown flag/);
  assert.match((parsePluginCommand("install Bad@Name") as { message: string }).message, /<plugin>\[@marketplace\]/);
  assert.match((parsePluginCommand("install a@b@c") as { message: string }).message, /<plugin>\[@marketplace\]/);
});

test("parses update checks, update targets and marketplace refetches", () => {
  assert.deepEqual(parsePluginCommand("update"), { kind: "update-check" });
  assert.deepEqual(parsePluginCommand("update superpowers"), {
    kind: "update", name: "superpowers", scope: "user", confirmed: false,
  });
  assert.deepEqual(parsePluginCommand("update superpowers@fixture --yes"), {
    kind: "update", name: "superpowers", marketplace: "fixture", scope: "user", confirmed: true,
  });
  assert.deepEqual(parsePluginCommand("update superpowers --project --yes"), {
    kind: "update", name: "superpowers", scope: "project", confirmed: true,
  });
  assert.deepEqual(parsePluginCommand("marketplace update"), { kind: "marketplace-update" });
  assert.deepEqual(parsePluginCommand("marketplace update fixture"), { kind: "marketplace-update", name: "fixture" });
  // `--yes` with nothing to apply it to is refused rather than silently updating everything.
  assert.match((parsePluginCommand("update --yes") as { message: string }).message, /Name a plugin/);
  assert.match((parsePluginCommand("update --project") as { message: string }).message, /Name a plugin/);
  assert.match((parsePluginCommand("update a b") as { message: string }).message, /Usage/);
  assert.match((parsePluginCommand("update a --force") as { message: string }).message, /Unknown flag/);
});

test("parses enable and disable targets and scopes", () => {
  assert.deepEqual(parsePluginCommand("disable superpowers"), {
    kind: "toggle", name: "superpowers", scope: "user", enabled: false,
  });
  assert.deepEqual(parsePluginCommand("enable superpowers@fixture --project"), {
    kind: "toggle", name: "superpowers", marketplace: "fixture", scope: "project", enabled: true,
  });
  assert.match((parsePluginCommand("enable") as { message: string }).message, /Usage/);
  assert.match((parsePluginCommand("enable a --yes") as { message: string }).message, /Unknown flag/);
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

/* ------------------------------------------------------------------ */
/* Install and uninstall                                               */
/* ------------------------------------------------------------------ */

test("installs a git plugin into the versioned cache and records marketplace, version and sha", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });

  const record = await installPlugin({ name: "superpowers", homeDirectory });
  assert.equal(record.marketplace, "fixture");
  assert.equal(record.version, "6.3.0");
  assert.equal(record.commitSha, bundle.sha);
  assert.equal(record.scope, "user");
  assert.equal(record.projectRoot, null);
  assert.equal(record.path, "cache/fixture/superpowers/6.3.0");

  const cache = pluginCachePath("fixture", "superpowers", "6.3.0", homeDirectory);
  assert.equal((await stat(join(cache, "skills", "brainstorming", "SKILL.md"))).isFile(), true);
  // Everything else in the bundle is cached verbatim; only `.git` is dropped.
  assert.equal((await stat(join(cache, "agents", "helper.md"))).isFile(), true);
  await assert.rejects(stat(join(cache, ".git")));

  const registry = await loadInstalledPlugins(homeDirectory);
  assert.deepEqual(Object.keys(registry.plugins), ["superpowers@fixture"]);
  assert.equal(registry.plugins["superpowers@fixture"]?.length, 1);
  assert.deepEqual(listedFlags(await listMarketplacePlugins({ homeDirectory })), [["superpowers", true]]);
  assert.equal((await stat(join(pluginsDirectory(homeDirectory), "installed_plugins.json"))).mode & 0o777, 0o600);
});

function listedFlags(entries: Awaited<ReturnType<typeof listMarketplacePlugins>>): [string, boolean][] {
  return entries.map((entry) => [entry.plugin.name, entry.installed]);
}

test("names the cache directory by the sha when nothing supplies a version", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture();
  const marketplace = await marketplaceFixture([
    { name: "unpinned", description: "No version anywhere", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });

  const record = await installPlugin({ name: "unpinned", homeDirectory });
  assert.equal(record.version, bundle.sha.slice(0, 12));
  assert.equal((await stat(pluginCachePath("fixture", "unpinned", record.version, homeDirectory))).isDirectory(), true);
});

test("checks out a pinned sha and installs a bundle from a subdirectory", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "mono-plugin" }, "plugins/foo");
  // A second commit, so a pinned sha is provably not just "whatever HEAD is".
  await writeFile(join(bundle.path, "README.md"), "later\n");
  await run("git", ["add", "-A"], { cwd: bundle.path });
  await run("git", ["commit", "-qm", "later"], { cwd: bundle.path });

  const marketplace = await marketplaceFixture([
    {
      name: "mono-plugin",
      description: "From a subdirectory",
      version: "2.1.0",
      source: { source: "git-subdir", url: bundle.path, path: "plugins/foo", ref: "main", sha: bundle.sha },
    },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });

  const record = await installPlugin({ name: "mono-plugin", homeDirectory });
  assert.equal(record.commitSha, bundle.sha);
  assert.equal(record.version, "2.1.0");
  const cache = pluginCachePath("fixture", "mono-plugin", "2.1.0", homeDirectory);
  assert.equal((await stat(join(cache, "skills", "brainstorming", "SKILL.md"))).isFile(), true);
  // The bundle root is the subdirectory, not the repository root.
  await assert.rejects(stat(join(cache, "plugins")));
  await assert.rejects(stat(join(cache, "README.md")));
});

test("installs a directory plugin from inside the marketplace checkout", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const marketplace = await marketplaceFixture([
    { name: "local-plugin", description: "Bare string source", version: "0.1.0", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });

  const record = await installPlugin({ name: "local-plugin", homeDirectory });
  assert.equal(record.commitSha, "");
  assert.equal(record.version, "0.1.0");
  assert.equal(
    (await stat(join(pluginCachePath("fixture", "local-plugin", "0.1.0", homeDirectory), "skills", "brainstorming", "SKILL.md"))).isFile(),
    true,
  );
});

test("refuses a directory source that escapes the marketplace, and an unresolvable version", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const marketplace = await marketplaceFixture([
    { name: "escapee", description: "Points outside", source: "../../etc" },
    { name: "versionless", description: "No version and no sha", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });

  await assert.rejects(installPlugin({ name: "escapee", homeDirectory }), /escapes its marketplace directory/);
  await assert.rejects(installPlugin({ name: "versionless", homeDirectory }), /Could not resolve a version/);
  assert.deepEqual((await loadInstalledPlugins(homeDirectory)).plugins, {});
  await assert.rejects(stat(join(pluginsDirectory(homeDirectory), "cache", "fixture", "versionless")));
});

test("refuses a plugin no added marketplace publishes, and an ambiguous bare name", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const first = await marketplaceFixture([{ name: "shared", description: "d", version: "1", source: "./plugins/local" }]);
  const second = await marketplaceFixture([{ name: "shared", description: "d", version: "1", source: "./plugins/local" }]);
  await bundleFixture(join(first, "plugins", "local"));
  await bundleFixture(join(second, "plugins", "local"));

  await assert.rejects(installPlugin({ name: "shared", homeDirectory }), /No added marketplace publishes/);
  await addMarketplace({ spec: first, alias: "one", homeDirectory });
  await addMarketplace({ spec: second, alias: "two", homeDirectory });
  await assert.rejects(installPlugin({ name: "shared", homeDirectory }), /shared@<marketplace>/);
  await assert.rejects(installPlugin({ name: "shared", marketplace: "three", homeDirectory }), /not added/);
  await assert.rejects(installPlugin({ name: "absent", marketplace: "one", homeDirectory }), /publishes no plugin named/);

  assert.equal((await installPlugin({ name: "shared", marketplace: "two", homeDirectory })).marketplace, "two");
});

test("keeps one record per scope over the one shared cache bundle", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "amber-project-"));
  const marketplace = await marketplaceFixture([
    { name: "local-plugin", description: "d", version: "0.1.0", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });

  await installPlugin({ name: "local-plugin", homeDirectory });
  const scoped = await installPlugin({ name: "local-plugin", scope: "project", projectRoot, homeDirectory });
  assert.equal(scoped.projectRoot, projectRoot);

  const records = (await loadInstalledPlugins(homeDirectory)).plugins["local-plugin@fixture"] ?? [];
  assert.deepEqual(records.map((record) => record.scope), ["project", "user"]);
  await assert.rejects(installPlugin({ name: "local-plugin", scope: "project", homeDirectory }), /needs a project root/);

  // Re-installing the same scope replaces its record rather than appending one.
  await installPlugin({ name: "local-plugin", scope: "project", projectRoot, homeDirectory });
  assert.equal(((await loadInstalledPlugins(homeDirectory)).plugins["local-plugin@fixture"] ?? []).length, 2);

  // The project record goes; the cache stays, because the user record still holds it.
  await uninstallPlugin({ name: "local-plugin", scope: "project", projectRoot, homeDirectory });
  const remaining = (await loadInstalledPlugins(homeDirectory)).plugins["local-plugin@fixture"] ?? [];
  assert.deepEqual(remaining.map((record) => record.scope), ["user"]);
  assert.equal((await stat(pluginCachePath("fixture", "local-plugin", "0.1.0", homeDirectory))).isDirectory(), true);
});

test("uninstall leaves no trace of the plugin", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const marketplace = await marketplaceFixture([
    { name: "local-plugin", description: "d", version: "0.1.0", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "local-plugin", homeDirectory });

  const removed = await uninstallPlugin({ name: "local-plugin", homeDirectory });
  assert.equal(removed.version, "0.1.0");
  assert.deepEqual((await loadInstalledPlugins(homeDirectory)).plugins, {});
  await assert.rejects(stat(join(pluginsDirectory(homeDirectory), "cache", "fixture")));
  assert.deepEqual(listedFlags(await listMarketplacePlugins({ homeDirectory })), [["local-plugin", false]]);
  await assert.rejects(uninstallPlugin({ name: "local-plugin", homeDirectory }), /is not installed/);
  // The marketplace checkout is untouched by an uninstall.
  assert.equal((await stat(marketplaceCheckoutPath("fixture", homeDirectory))).isDirectory(), true);
});

test("replacing an installed version discards the cache the old record held", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const marketplace = await marketplaceFixture([
    { name: "local-plugin", description: "d", version: "0.1.0", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });
  const first = await installPlugin({ name: "local-plugin", homeDirectory });

  await removeMarketplace("fixture", homeDirectory);
  await writeFile(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture",
      plugins: [{ name: "local-plugin", description: "d", version: "0.2.0", source: "./plugins/local" }],
    }),
  );
  await addMarketplace({ spec: marketplace, homeDirectory });
  const second = await installPlugin({ name: "local-plugin", homeDirectory });

  assert.equal(second.version, "0.2.0");
  assert.equal(second.installedAt, first.installedAt); // first install time survives a replace
  assert.equal(((await loadInstalledPlugins(homeDirectory)).plugins["local-plugin@fixture"] ?? []).length, 1);
  await assert.rejects(stat(pluginCachePath("fixture", "local-plugin", "0.1.0", homeDirectory)));
  assert.equal((await stat(pluginCachePath("fixture", "local-plugin", "0.2.0", homeDirectory))).isDirectory(), true);
});

/* ------------------------------------------------------------------ */
/* Install confirmation                                                */
/* ------------------------------------------------------------------ */

test("plans an install without fetching, resolving the sha from the remote", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path, ref: "main" } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });

  const plan = await planPluginInstall({ name: "superpowers", homeDirectory });
  assert.equal(plan.key, "superpowers@fixture");
  assert.equal(plan.sha, bundle.sha);
  assert.equal(plan.ref, "main");
  assert.equal(plan.version, undefined); // only the bundle manifest knows it
  assert.equal(plan.replaces, undefined);
  await assert.rejects(stat(join(pluginsDirectory(homeDirectory), "cache")));

  const rendered = renderPluginInstallPlan(plan);
  assert.match(rendered, /superpowers@fixture/);
  assert.match(rendered, new RegExp(bundle.sha));
  assert.match(rendered, /run shell commands with your privileges/);
  assert.match(rendered, /--yes/);
});

test("renders installed plugins", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  assert.match(renderInstalledPlugins(await loadInstalledPlugins(homeDirectory)), /No plugins installed/);

  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "superpowers", homeDirectory });

  const rendered = renderInstalledPlugins(await loadInstalledPlugins(homeDirectory));
  assert.match(rendered, /superpowers@fixture/);
  assert.match(rendered, /6\.3\.0/);
  assert.match(rendered, new RegExp(bundle.sha.slice(0, 12)));
  assert.doesNotMatch(rendered, /disabled/);

  const disabled = renderInstalledPlugins(
    await loadInstalledPlugins(homeDirectory),
    { "superpowers@fixture": false },
  );
  assert.match(disabled, /_\(disabled\)_/);
});

test("resolves the installed key a toggle names", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "superpowers", homeDirectory });

  assert.equal(await installedPluginKey("superpowers", undefined, homeDirectory), "superpowers@fixture");
  assert.equal(await installedPluginKey("superpowers", "fixture", homeDirectory), "superpowers@fixture");
  await assert.rejects(
    installedPluginKey("superpowers", "other", homeDirectory),
    /superpowers@other' is not installed/,
  );
  await assert.rejects(installedPluginKey("missing", undefined, homeDirectory), /is not installed/);
});

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

test("a key absent from the enable table means enabled", () => {
  assert.equal(isPluginEnabled("superpowers@fixture"), true);
  assert.equal(isPluginEnabled("superpowers@fixture", {}), true);
  assert.equal(isPluginEnabled("superpowers@fixture", { "superpowers@fixture": true }), true);
  assert.equal(isPluginEnabled("superpowers@fixture", { "superpowers@fixture": false }), false);
});

test("an installed plugin is a discovery bundle until it is disabled", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "superpowers", homeDirectory });

  const cwd = await mkdtemp(join(tmpdir(), "amber-cwd-"));
  assert.deepEqual(await enabledPluginBundles({ cwd, homeDirectory }), [{
    key: "superpowers@fixture",
    name: "superpowers",
    bundle: pluginCachePath("fixture", "superpowers", "6.3.0", homeDirectory),
  }]);

  const disabled = await enabledPluginBundles({
    cwd,
    homeDirectory,
    enabledPlugins: { "superpowers@fixture": false },
  });
  assert.deepEqual(disabled, []);
});

test("a project-scoped record applies only inside its project root", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "amber-project-"));
  const cachePath = pluginCachePath("fixture", "scoped", "1.0.0", homeDirectory);
  await mkdir(join(cachePath, "skills"), { recursive: true });
  await saveInstalledPlugins({
    version: 1,
    plugins: {
      "scoped@fixture": [{
        scope: "project",
        projectRoot,
        name: "scoped",
        marketplace: "fixture",
        version: "1.0.0",
        commitSha: "",
        source: { type: "directory", path: cachePath },
        path: pluginCacheRelativePath("fixture", "scoped", "1.0.0"),
        installedAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      }],
    },
  }, homeDirectory);

  const inside = await enabledPluginBundles({ cwd: join(projectRoot, "packages", "web"), homeDirectory });
  assert.deepEqual(inside.map((entry) => entry.key), ["scoped@fixture"]);

  const outside = await enabledPluginBundles({ cwd: await mkdtemp(join(tmpdir(), "amber-other-")), homeDirectory });
  assert.deepEqual(outside, []);
});

test("a record whose bundle is gone is skipped rather than failing discovery", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  await saveInstalledPlugins({
    version: 1,
    plugins: {
      "ghost@fixture": [{
        scope: "user",
        projectRoot: null,
        name: "ghost",
        marketplace: "fixture",
        version: "1.0.0",
        commitSha: "",
        source: { type: "directory", path: "/nowhere" },
        path: pluginCacheRelativePath("fixture", "ghost", "1.0.0"),
        installedAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      }],
    },
  }, homeDirectory);

  assert.deepEqual(await enabledPluginBundles({ cwd: homeDirectory, homeDirectory }), []);
});

/* ------------------------------------------------------------------ */
/* Update and check                                                    */
/* ------------------------------------------------------------------ */

/** Commits a new plugin.json version plus a second skill on top of a bundle repo. */
async function publishBundleVersion(bundle: string, version: string): Promise<string> {
  await writeFile(join(bundle, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version }));
  await mkdir(join(bundle, "skills", "debugging"), { recursive: true });
  await writeFile(join(bundle, "skills", "debugging", "SKILL.md"), "---\nname: debugging\n---\nBody\n");
  await run("git", ["add", "-A"], { cwd: bundle });
  await run("git", ["commit", "-qm", version], { cwd: bundle });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: bundle });
  return stdout.trim();
}

async function installedFixture(): Promise<{ homeDirectory: string; bundle: string; sha: string }> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const bundle = await gitBundleFixture({ name: "superpowers", version: "6.3.0" });
  const marketplace = await marketplaceFixture([
    { name: "superpowers", description: "Skills", source: { source: "url", url: bundle.path } },
  ]);
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "superpowers", homeDirectory });
  return { homeDirectory, bundle: bundle.path, sha: bundle.sha };
}

test("reports no drift while the published commit matches the installed one", async () => {
  const fixture = await installedFixture();
  const statuses = await checkPluginUpdates({ homeDirectory: fixture.homeDirectory });
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.key, "superpowers@fixture");
  assert.equal(statuses[0]?.state, "current");
  assert.equal(statuses[0]?.publishedSha, fixture.sha);
  assert.match(renderPluginUpdateReport(statuses), /up to date/);

  const result = await updatePlugin({ name: "superpowers", homeDirectory: fixture.homeDirectory });
  assert.equal(result.updated, false);
  assert.equal(result.record.commitSha, fixture.sha);
});

test("reports drift when the marketplace publishes a newer commit", async () => {
  const fixture = await installedFixture();
  const published = await publishBundleVersion(fixture.bundle, "6.4.0");

  const [status] = await checkPluginUpdates({ homeDirectory: fixture.homeDirectory });
  assert.equal(status?.state, "drifted");
  assert.equal(status?.publishedSha, published);
  assert.equal(status?.record.commitSha, fixture.sha);

  const report = renderPluginUpdateReport(await checkPluginUpdates({ homeDirectory: fixture.homeDirectory }));
  assert.match(report, /superpowers@fixture/);
  assert.match(report, new RegExp(published.slice(0, 12)));
  assert.match(report, /\/plugin update/);

  // Checking reports; it never fetches a bundle.
  const plan = await planPluginUpdate({ name: "superpowers", homeDirectory: fixture.homeDirectory });
  assert.equal(plan.state, "drifted");
  const rendered = renderPluginUpdatePlan(plan);
  assert.match(rendered, new RegExp(fixture.sha));
  assert.match(rendered, new RegExp(published));
  assert.match(rendered, /--yes/);
  assert.equal((await loadInstalledPlugins(fixture.homeDirectory)).plugins["superpowers@fixture"]?.[0]?.commitSha, fixture.sha);
});

test("applying an update keeps the install time, the enable state and the skill namespace", async () => {
  const fixture = await installedFixture();
  const { homeDirectory } = fixture;
  const first = (await loadInstalledPlugins(homeDirectory)).plugins["superpowers@fixture"]?.[0];
  const published = await publishBundleVersion(fixture.bundle, "6.4.0");

  const result = await updatePlugin({ name: "superpowers", homeDirectory });
  assert.equal(result.updated, true);
  assert.equal(result.previous.version, "6.3.0");
  assert.equal(result.record.version, "6.4.0");
  assert.equal(result.record.commitSha, published);
  assert.equal(result.record.installedAt, first?.installedAt);
  assert.notEqual(result.record.updatedAt, first?.updatedAt);

  // One record, one cache directory: the replaced version is discarded.
  assert.equal(((await loadInstalledPlugins(homeDirectory)).plugins["superpowers@fixture"] ?? []).length, 1);
  await assert.rejects(stat(pluginCachePath("fixture", "superpowers", "6.3.0", homeDirectory)));
  const cache = pluginCachePath("fixture", "superpowers", "6.4.0", homeDirectory);
  assert.equal((await stat(join(cache, "skills", "debugging", "SKILL.md"))).isFile(), true);

  // Same key, same namespace, still enabled - the settings table was never touched.
  const cwd = await mkdtemp(join(tmpdir(), "amber-cwd-"));
  assert.deepEqual(await enabledPluginBundles({ cwd, homeDirectory }), [
    { key: "superpowers@fixture", name: "superpowers", bundle: cache },
  ]);
  assert.deepEqual(await enabledPluginBundles({ cwd, homeDirectory, enabledPlugins: { "superpowers@fixture": false } }), []);
  assert.match(renderPluginUpdated(result), /6\.3\.0.*6\.4\.0/s);
  assert.equal((await checkPluginUpdates({ homeDirectory }))[0]?.state, "current");
});

test("a directory-sourced plugin cannot drift on a commit but does on a published version", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const marketplace = await marketplaceFixture([
    { name: "local-plugin", description: "d", version: "0.1.0", source: "./plugins/local" },
  ]);
  await bundleFixture(join(marketplace, "plugins", "local"));
  await addMarketplace({ spec: marketplace, homeDirectory });
  await installPlugin({ name: "local-plugin", homeDirectory });

  assert.equal((await checkPluginUpdates({ homeDirectory }))[0]?.state, "local");

  await writeFile(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture",
      plugins: [{ name: "local-plugin", description: "d", version: "0.2.0", source: "./plugins/local" }],
    }),
  );
  const refetched = await updateMarketplace("fixture", homeDirectory);
  assert.equal(refetched.plugins, 1);

  const [status] = await checkPluginUpdates({ homeDirectory });
  assert.equal(status?.state, "drifted");
  assert.equal(status?.publishedVersion, "0.2.0");
  assert.equal((await updatePlugin({ name: "local-plugin", homeDirectory })).record.version, "0.2.0");
});

test("refetches a marketplace checkout and records the commit it moved to", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-plugins-"));
  const origin = await gitMarketplaceFixture([{ name: "one", description: "d", source: "./plugins/one" }]);
  await addMarketplace({ spec: origin.path, homeDirectory, treatDirectoryAsGit: true });

  const unchanged = await updateMarketplace("fixture", homeDirectory);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.commitSha, origin.sha);

  await writeFile(
    join(origin.path, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture",
      plugins: [
        { name: "one", description: "d", source: "./plugins/one" },
        { name: "two", description: "d", source: "./plugins/two" },
      ],
    }),
  );
  await run("git", ["commit", "-qam", "publish two"], { cwd: origin.path });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: origin.path });

  const updated = await updateMarketplace("fixture", homeDirectory);
  assert.equal(updated.changed, true);
  assert.equal(updated.previousSha, origin.sha);
  assert.equal(updated.commitSha, stdout.trim());
  assert.equal(updated.plugins, 2);
  assert.equal((await loadMarketplaceRegistry(homeDirectory)).marketplaces.fixture?.commitSha, stdout.trim());
  assert.deepEqual(
    (await listMarketplacePlugins({ homeDirectory })).map((entry) => entry.plugin.name),
    ["one", "two"],
  );
  assert.match(renderMarketplaceUpdate([updated]), /fixture/);
  await assert.rejects(updateMarketplace("absent", homeDirectory), /not added/);
});

test("an installed plugin its marketplace no longer publishes is unavailable, not drifted", async () => {
  const fixture = await installedFixture();
  await removeMarketplace("fixture", fixture.homeDirectory);

  const [status] = await checkPluginUpdates({ homeDirectory: fixture.homeDirectory });
  assert.equal(status?.state, "unavailable");
  assert.match(status?.reason ?? "", /no longer added/);
  assert.match(renderPluginUpdateReport([status as PluginUpdateStatus]), /no longer added/);
  await assert.rejects(updatePlugin({ name: "superpowers", homeDirectory: fixture.homeDirectory }), /no longer added/);

  await assert.rejects(
    planPluginUpdate({ name: "superpowers", scope: "project", projectRoot: "/tmp", homeDirectory: fixture.homeDirectory }),
    /not installed at project scope/,
  );
});
