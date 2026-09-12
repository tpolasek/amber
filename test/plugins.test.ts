import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  addMarketplace,
  installPlugin,
  loadInstalledPlugins,
  loadMarketplaceRegistry,
  listMarketplacePlugins,
  marketplaceCheckoutPath,
  parseMarketplaceManifest,
  parseMarketplaceSpec,
  parsePluginCommand,
  planPluginInstall,
  pluginCachePath,
  pluginsDirectory,
  removeMarketplace,
  renderInstalledPlugins,
  renderMarketplaceList,
  renderPluginInstallPlan,
  renderPluginList,
  saveMarketplaceRegistry,
  uninstallPlugin,
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
});
