import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const GIT_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Where a plugin bundle is fetched from, as published in a marketplace manifest. */
export type PluginSource =
  | { type: "url"; url: string; ref?: string; sha?: string; path?: string }
  | { type: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
  | { type: "directory"; path: string };

export interface MarketplacePlugin {
  name: string;
  description: string;
  source: PluginSource;
  version?: string;
  author?: string;
  homepage?: string;
  category?: string;
  license?: string;
  keywords?: string[];
}

export interface MarketplaceManifest {
  name: string;
  description?: string;
  owner?: string;
  plugins: MarketplacePlugin[];
}

/** Where a marketplace itself is fetched from. */
export type MarketplaceSource =
  | { type: "url"; url: string; ref?: string }
  | { type: "directory"; path: string };

export interface MarketplaceRecord {
  source: MarketplaceSource;
  addedAt: string;
  lastFetchedAt: string;
  /**
   * Full commit sha of the checkout. The reference Claude Code checkout is an
   * unpacked tarball with no `.git`, so the sha is recorded here on every fetch
   * rather than read back from the checkout.
   */
  commitSha?: string;
}

export interface MarketplaceRegistry {
  version: 1;
  marketplaces: Record<string, MarketplaceRecord>;
}

export interface MarketplacePluginEntry {
  marketplace: string;
  plugin: MarketplacePlugin;
  installed: boolean;
}

/** A plugin is installed for the user, or for one project only. */
export type PluginScope = "user" | "project";

export interface InstalledPluginRecord {
  scope: PluginScope;
  /** Absolute root whose `.amber` owns the install; null at user scope. */
  projectRoot: string | null;
  name: string;
  marketplace: string;
  version: string;
  /** Full commit sha of the bundle source; empty for a `directory` source. */
  commitSha: string;
  source: PluginSource;
  /** Relative to `~/.amber/plugins`, so a profile stays movable. */
  path: string;
  installedAt: string;
  updatedAt: string;
}

/** `<plugin>@<marketplace>` to at most one record per scope, matching Claude Code. */
export interface InstalledPluginRegistry {
  version: 1;
  plugins: Record<string, InstalledPluginRecord[]>;
}

/** What `/plugin install` prints before it fetches anything. */
export interface PluginInstallPlan {
  key: string;
  marketplace: string;
  plugin: MarketplacePlugin;
  scope: PluginScope;
  projectRoot: string | null;
  source: PluginSource;
  ref?: string;
  /** Resolved without fetching a tree; absent for a `directory` source. */
  sha?: string;
  /** Known before the fetch; otherwise the bundle manifest decides. */
  version?: string;
  replaces?: InstalledPluginRecord;
}

export type PluginCommand =
  | { kind: "overview" }
  | { kind: "marketplace-list" }
  | { kind: "marketplace-add"; spec: string; alias?: string }
  | { kind: "marketplace-remove"; name: string }
  | { kind: "marketplace-update"; name?: string }
  | { kind: "list"; marketplace?: string }
  | { kind: "installed" }
  | { kind: "update-check" }
  | { kind: "update"; name: string; marketplace?: string; scope: PluginScope; confirmed: boolean }
  | { kind: "install"; name: string; marketplace?: string; scope: PluginScope; confirmed: boolean }
  | { kind: "uninstall"; name: string; marketplace?: string; scope: PluginScope }
  | { kind: "toggle"; name: string; marketplace?: string; scope: PluginScope; enabled: boolean }
  | { kind: "error"; message: string };

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function pluginsDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ".amber", "plugins");
}

export function marketplaceCheckoutPath(name: string, homeDirectory = homedir()): string {
  return join(pluginsDirectory(homeDirectory), "marketplaces", name);
}

/** Cache path of one installed version, relative to `~/.amber/plugins`. */
export function pluginCacheRelativePath(marketplace: string, plugin: string, version: string): string {
  return ["cache", marketplace, plugin, version].join("/");
}

export function pluginCachePath(marketplace: string, plugin: string, version: string, homeDirectory = homedir()): string {
  return join(pluginsDirectory(homeDirectory), "cache", marketplace, plugin, version);
}

export function pluginKey(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}

/* ------------------------------------------------------------------ */
/* Spec parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Turns what a user types after `/plugin marketplace add` into a source:
 * `owner/name[@ref]` is GitHub, anything with a scheme or scp-style host is a
 * git URL, and everything else is a local directory.
 */
export function parseMarketplaceSpec(spec: string): MarketplaceSource {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("Marketplace source must be a non-empty string");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[^/\s]+@[^/\s]+:/.test(trimmed)) {
    return { type: "url", url: trimmed };
  }
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@(.+))?$/.exec(trimmed);
  if (shorthand && !trimmed.startsWith(".") && !isAbsolute(trimmed)) {
    const [, owner, repository, ref] = shorthand;
    return { type: "url", url: `https://github.com/${owner}/${repository}.git`, ...(ref ? { ref } : {}) };
  }
  return { type: "directory", path: trimmed };
}

/* ------------------------------------------------------------------ */
/* Manifest parsing                                                    */
/* ------------------------------------------------------------------ */

export function parseMarketplaceManifest(value: unknown, manifestPath: string): MarketplaceManifest {
  if (!isRecord(value)) throw new Error(`${manifestPath} must contain a JSON object`);
  const name = String(value.name ?? "");
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${manifestPath}: name must match [a-z0-9][a-z0-9-]*`);
  }
  if (!Array.isArray(value.plugins)) throw new Error(`${manifestPath}: plugins must be an array`);

  const seen = new Set<string>();
  const plugins = value.plugins.map((candidate, index) => {
    const plugin = parseMarketplacePlugin(candidate, `${manifestPath}: plugins[${index}]`);
    if (seen.has(plugin.name)) throw new Error(`${manifestPath}: duplicate plugin name '${plugin.name}'`);
    seen.add(plugin.name);
    return plugin;
  });

  const description = optionalString(value.description);
  const owner = personName(value.owner);
  return {
    name,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    plugins,
  };
}

function parseMarketplacePlugin(value: unknown, field: string): MarketplacePlugin {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const name = String(value.name ?? "");
  if (!NAME_PATTERN.test(name)) throw new Error(`${field}.name must match [a-z0-9][a-z0-9-]*`);
  const description = optionalString(value.description);
  if (!description) throw new Error(`${field}.description must be a non-empty string`);
  if (value.source === undefined) throw new Error(`${field}.source is required`);
  const version = optionalString(value.version);
  const author = personName(value.author);
  const homepage = optionalString(value.homepage);
  const category = optionalString(value.category);
  const license = optionalString(value.license);
  return {
    name,
    description,
    source: parsePluginSource(value.source, `${field}.source`),
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    ...(homepage ? { homepage } : {}),
    ...(category ? { category } : {}),
    ...(license ? { license } : {}),
    ...(Array.isArray(value.keywords)
      ? { keywords: value.keywords.filter((keyword): keyword is string => typeof keyword === "string") }
      : {}),
  };
}

/**
 * Claude Code manifests key the discriminator `source` and name a subdirectory
 * `path`; Amber's own manifests write `type`. Both are accepted, plus the bare
 * string and `github` forms the official marketplace uses.
 */
function parsePluginSource(value: unknown, field: string): PluginSource {
  if (typeof value === "string") {
    const path = value.trim();
    if (!path) throw new Error(`${field} must be a non-empty string`);
    return { type: "directory", path };
  }
  if (!isRecord(value)) throw new Error(`${field} must be a string or an object`);

  const kind = optionalString(value.source) ?? optionalString(value.type);
  const url = optionalString(value.url);
  const ref = optionalString(value.ref);
  const sha = optionalString(value.sha);
  const path = optionalString(value.path);

  if (kind === "github") {
    const repository = optionalString(value.repo);
    if (!repository) throw new Error(`${field}.repo must be a non-empty string`);
    return { type: "url", url: `https://github.com/${repository}.git`, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
  }
  if (kind === "directory") {
    if (!path) throw new Error(`${field}.path must be a non-empty string`);
    return { type: "directory", path };
  }
  if (kind === "git-subdir") {
    if (!url) throw new Error(`${field}.url must be a non-empty string`);
    if (!path) throw new Error(`${field}.path must be a non-empty string`);
    return { type: "git-subdir", url, path, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
  }
  if (kind === "url") {
    if (!url) throw new Error(`${field}.url must be a non-empty string`);
    return { type: "url", url, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}), ...(path ? { path } : {}) };
  }
  throw new Error(`${field} must be url, git-subdir, directory, or github`);
}

/* ------------------------------------------------------------------ */
/* Command parsing                                                     */
/* ------------------------------------------------------------------ */

const MARKETPLACE_ADD_USAGE = "Usage: /plugin marketplace add <owner/repo | url | directory> [as <name>]";

export function parsePluginCommand(argument: string): PluginCommand {
  const words = argument.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "overview" };
  const [head, ...rest] = words;

  if (head === "marketplace" || head === "marketplaces") {
    const action = rest[0] ?? (head === "marketplaces" ? "list" : "list");
    const operands = rest.slice(1);
    if (action === "list") {
      return operands.length === 0 ? { kind: "marketplace-list" } : { kind: "error", message: "Usage: /plugin marketplace list" };
    }
    if (action === "add") {
      const [spec, ...tail] = operands;
      if (!spec) return { kind: "error", message: MARKETPLACE_ADD_USAGE };
      if (tail.length === 0) return { kind: "marketplace-add", spec };
      const alias = tail[1];
      if (tail.length === 2 && tail[0] === "as" && alias) return { kind: "marketplace-add", spec, alias };
      return { kind: "error", message: MARKETPLACE_ADD_USAGE };
    }
    if (action === "remove") {
      const name = operands[0];
      if (operands.length !== 1 || !name) return { kind: "error", message: "Usage: /plugin marketplace remove <name>" };
      return { kind: "marketplace-remove", name };
    }
    if (action === "update") {
      const name = operands[0];
      if (operands.length > 1) return { kind: "error", message: "Usage: /plugin marketplace update [name]" };
      return { kind: "marketplace-update", ...(name ? { name } : {}) };
    }
    return { kind: "error", message: `Unknown marketplace action: ${action}` };
  }

  if (head === "list") {
    const marketplace = rest[0];
    if (rest.length === 0) return { kind: "list" };
    if (rest.length === 1 && marketplace) return { kind: "list", marketplace };
    return { kind: "error", message: "Usage: /plugin list [marketplace]" };
  }

  if (head === "installed") {
    return rest.length === 0 ? { kind: "installed" } : { kind: "error", message: "Usage: /plugin installed" };
  }

  if (head === "enable" || head === "disable") {
    const flags = new Set(rest.filter((word) => word.startsWith("--")));
    const operands = rest.filter((word) => !word.startsWith("--"));
    const usage = `Usage: /plugin ${head} <plugin>[@marketplace] [--project]`;
    const unknown = [...flags].find((flag) => flag !== "--project");
    if (unknown) return { kind: "error", message: `Unknown flag ${unknown}. ${usage}` };
    const [spec] = operands;
    if (operands.length !== 1 || !spec) return { kind: "error", message: usage };
    const target = parsePluginTarget(spec);
    if (!target) return { kind: "error", message: `Plugin must be named <plugin>[@marketplace]: ${spec}` };
    return {
      kind: "toggle",
      ...target,
      scope: flags.has("--project") ? "project" : "user",
      enabled: head === "enable",
    };
  }

  if (head === "update") {
    const flags = new Set(rest.filter((word) => word.startsWith("--")));
    const operands = rest.filter((word) => !word.startsWith("--"));
    const usage = "Usage: /plugin update [<plugin>[@marketplace]] [--project] [--yes]";
    const unknown = [...flags].find((flag) => flag !== "--project" && flag !== "--yes");
    if (unknown) return { kind: "error", message: `Unknown flag ${unknown}. ${usage}` };
    if (operands.length > 1) return { kind: "error", message: usage };
    const [spec] = operands;
    if (!spec) {
      // Bare `/plugin update` reports drift for everything; applying one is always named.
      if (flags.size > 0) return { kind: "error", message: `Name a plugin to update. ${usage}` };
      return { kind: "update-check" };
    }
    const target = parsePluginTarget(spec);
    if (!target) return { kind: "error", message: `Plugin must be named <plugin>[@marketplace]: ${spec}` };
    return {
      kind: "update",
      ...target,
      scope: flags.has("--project") ? "project" : "user",
      confirmed: flags.has("--yes"),
    };
  }

  if (head === "install" || head === "uninstall") {
    const flags = new Set(rest.filter((word) => word.startsWith("--")));
    const operands = rest.filter((word) => !word.startsWith("--"));
    const usage = `Usage: /plugin ${head} <plugin>[@marketplace] [--project]${head === "install" ? " [--yes]" : ""}`;
    const allowed = head === "install" ? ["--project", "--yes"] : ["--project"];
    const unknown = [...flags].find((flag) => !allowed.includes(flag));
    if (unknown) return { kind: "error", message: `Unknown flag ${unknown}. ${usage}` };
    const [spec] = operands;
    if (operands.length !== 1 || !spec) return { kind: "error", message: usage };
    const target = parsePluginTarget(spec);
    if (!target) return { kind: "error", message: `Plugin must be named <plugin>[@marketplace]: ${spec}` };
    const scope: PluginScope = flags.has("--project") ? "project" : "user";
    return head === "install"
      ? { kind: "install", ...target, scope, confirmed: flags.has("--yes") }
      : { kind: "uninstall", ...target, scope };
  }

  return { kind: "error", message: `Unknown /plugin action: ${head}` };
}

function parsePluginTarget(spec: string): { name: string; marketplace?: string } | undefined {
  const [name, marketplace, ...extra] = spec.split("@");
  if (extra.length > 0 || !name || !NAME_PATTERN.test(name)) return undefined;
  if (marketplace === undefined) return { name };
  if (!NAME_PATTERN.test(marketplace)) return undefined;
  return { name, marketplace };
}

/* ------------------------------------------------------------------ */
/* Registry persistence                                                */
/* ------------------------------------------------------------------ */

export async function loadMarketplaceRegistry(homeDirectory = homedir()): Promise<MarketplaceRegistry> {
  const path = join(pluginsDirectory(homeDirectory), "marketplaces.json");
  const parsed = await readJsonFile(path);
  if (!isRecord(parsed) || !isRecord(parsed.marketplaces)) return { version: 1, marketplaces: {} };
  return { version: 1, marketplaces: parsed.marketplaces as Record<string, MarketplaceRecord> };
}

export async function saveMarketplaceRegistry(registry: MarketplaceRegistry, homeDirectory = homedir()): Promise<string> {
  return writeJsonFile(join(pluginsDirectory(homeDirectory), "marketplaces.json"), registry);
}

export async function loadInstalledPlugins(homeDirectory = homedir()): Promise<InstalledPluginRegistry> {
  const parsed = await readJsonFile(join(pluginsDirectory(homeDirectory), "installed_plugins.json"));
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return { version: 1, plugins: {} };
  return { version: 1, plugins: parsed.plugins as Record<string, InstalledPluginRecord[]> };
}

export async function saveInstalledPlugins(
  registry: InstalledPluginRegistry,
  homeDirectory = homedir(),
): Promise<string> {
  return writeJsonFile(join(pluginsDirectory(homeDirectory), "installed_plugins.json"), registry);
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Reads a marketplace manifest from a checkout, preferring Amber's own file and
 * falling back to the Claude-compatible one.
 */
export async function readMarketplaceManifest(root: string): Promise<MarketplaceManifest> {
  for (const directory of [".amber-plugin", ".claude-plugin"]) {
    const path = join(root, directory, "marketplace.json");
    const parsed = await readJsonFile(path);
    if (parsed !== undefined) return parseMarketplaceManifest(parsed, path);
  }
  throw new Error(`${root} has no .amber-plugin/marketplace.json or .claude-plugin/marketplace.json`);
}

async function fetchMarketplace(source: MarketplaceSource, destination: string): Promise<string | undefined> {
  await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
  const staging = `${destination}.tmp-${randomUUID()}`;
  try {
    if (source.type === "directory") {
      await run("cp", ["-R", `${resolve(source.path)}/.`, staging], { timeout: GIT_TIMEOUT_MS });
      await rename(staging, destination);
      return undefined;
    }
    await run("git", [
      "clone", "--quiet", "--depth", "1",
      ...(source.ref ? ["--branch", source.ref] : []),
      source.url, staging,
    ], { timeout: GIT_TIMEOUT_MS });
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: staging, timeout: GIT_TIMEOUT_MS });
    await rename(staging, destination);
    return stdout.trim();
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Reads a plugin bundle manifest. A bundle with no manifest at all is still
 * installable: name and version then come from the marketplace entry.
 */
export async function readPluginManifest(root: string): Promise<{ name?: string; version?: string } | undefined> {
  for (const directory of [".amber-plugin", ".claude-plugin"]) {
    const path = join(root, directory, "plugin.json");
    const parsed = await readJsonFile(path);
    if (parsed === undefined) continue;
    if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
    const name = optionalString(parsed.name);
    const version = optionalString(parsed.version);
    return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
  }
  return undefined;
}

/** Resolves a ref to a commit without fetching a tree, so a plan can be shown first. */
async function resolveRemoteSha(url: string, ref?: string): Promise<string> {
  const { stdout } = await run("git", ["ls-remote", url, ref ?? "HEAD"], { timeout: GIT_TIMEOUT_MS });
  const sha = stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0]?.split(/\s+/)[0];
  if (!sha) throw new Error(`Could not resolve ${ref ?? "HEAD"} in ${url}`);
  return sha;
}

/**
 * Checks a commit out into `staging` and returns its full sha. The `.git`
 * directory is dropped: the cached bundle is a tree, and drift is detected from
 * the registry's recorded sha rather than from a checkout.
 */
async function fetchGitTree(url: string, ref: string | undefined, sha: string | undefined, staging: string): Promise<string> {
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const git = (args: string[]) => run("git", args, { cwd: staging, timeout: GIT_TIMEOUT_MS });
  await git(["init", "-q"]);
  await git(["remote", "add", "origin", url]);
  const target = sha ?? ref;
  try {
    await git(["fetch", "-q", "--depth", "1", "origin", ...(target ? [target] : [])]);
    await git(["checkout", "-q", "FETCH_HEAD"]);
  } catch {
    // A server that will not serve an arbitrary commit needs the whole history.
    await git(["fetch", "-q", "origin"]);
    await git(["checkout", "-q", target ?? "FETCH_HEAD"]);
  }
  const { stdout } = await git(["rev-parse", "HEAD"]);
  await rm(join(staging, ".git"), { recursive: true, force: true });
  return stdout.trim();
}

/** Resolves a `directory` source against the marketplace checkout, refusing escapes. */
function resolveBundleDirectory(marketplaceRoot: string, path: string): string {
  const root = resolve(marketplaceRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`Plugin source '${path}' escapes its marketplace directory`);
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export interface AddMarketplaceOptions {
  spec: string;
  alias?: string;
  homeDirectory?: string;
  /** Clone a local path as a git repository instead of copying it (tests, and local clones). */
  treatDirectoryAsGit?: boolean;
}

export async function addMarketplace(options: AddMarketplaceOptions): Promise<{
  name: string;
  record: MarketplaceRecord;
  manifest: MarketplaceManifest;
}> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const parsed = parseMarketplaceSpec(options.spec);
  const source: MarketplaceSource = options.treatDirectoryAsGit && parsed.type === "directory"
    ? { type: "url", url: resolve(parsed.path) }
    : parsed;
  if (options.alias !== undefined && !NAME_PATTERN.test(options.alias)) {
    throw new Error(`Marketplace name must match [a-z0-9][a-z0-9-]*: ${options.alias}`);
  }

  const registry = await loadMarketplaceRegistry(homeDirectory);
  if (options.alias && registry.marketplaces[options.alias]) {
    throw new Error(`Marketplace '${options.alias}' is already added`);
  }

  // Fetch to a scratch checkout first: the manifest names the marketplace, so
  // its name is not known until after the fetch.
  const scratch = join(pluginsDirectory(homeDirectory), "marketplaces", `.probe-${randomUUID()}`);
  let manifest: MarketplaceManifest;
  let commitSha: string | undefined;
  try {
    commitSha = await fetchMarketplace(source, scratch);
    manifest = await readMarketplaceManifest(scratch);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }

  const name = options.alias ?? manifest.name;
  if (registry.marketplaces[name]) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error(`Marketplace '${name}' is already added`);
  }

  const destination = marketplaceCheckoutPath(name, homeDirectory);
  await rm(destination, { recursive: true, force: true });
  await rename(scratch, destination);

  const now = new Date().toISOString();
  const record: MarketplaceRecord = { source, addedAt: now, lastFetchedAt: now, ...(commitSha ? { commitSha } : {}) };
  registry.marketplaces[name] = record;
  await saveMarketplaceRegistry(registry, homeDirectory);
  return { name, record, manifest };
}

export async function removeMarketplace(name: string, homeDirectory = homedir()): Promise<void> {
  const registry = await loadMarketplaceRegistry(homeDirectory);
  if (!registry.marketplaces[name]) throw new Error(`Marketplace '${name}' is not added`);
  delete registry.marketplaces[name];
  await saveMarketplaceRegistry(registry, homeDirectory);
  await rm(marketplaceCheckoutPath(name, homeDirectory), { recursive: true, force: true });
}

export interface ListMarketplacePluginsOptions {
  homeDirectory?: string;
  marketplace?: string;
}

export async function listMarketplacePlugins(options: ListMarketplacePluginsOptions = {}): Promise<MarketplacePluginEntry[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const registry = await loadMarketplaceRegistry(homeDirectory);
  if (options.marketplace && !registry.marketplaces[options.marketplace]) {
    throw new Error(`Marketplace '${options.marketplace}' is not added`);
  }
  const names = (options.marketplace ? [options.marketplace] : Object.keys(registry.marketplaces)).sort();
  const installed = new Set(Object.keys((await loadInstalledPlugins(homeDirectory)).plugins));

  const entries: MarketplacePluginEntry[] = [];
  for (const marketplace of names) {
    const manifest = await readMarketplaceManifest(marketplaceCheckoutPath(marketplace, homeDirectory));
    for (const plugin of manifest.plugins) {
      entries.push({ marketplace, plugin, installed: installed.has(`${plugin.name}@${marketplace}`) });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Install and uninstall                                               */
/* ------------------------------------------------------------------ */

export interface PluginTargetOptions {
  name: string;
  marketplace?: string;
  scope?: PluginScope;
  /** Required at project scope; the root whose `.amber` owns the install. */
  projectRoot?: string;
  homeDirectory?: string;
}

interface ResolvedTarget {
  homeDirectory: string;
  marketplace: string;
  scope: PluginScope;
  projectRoot: string | null;
  key: string;
}

function resolveScope(options: PluginTargetOptions): { scope: PluginScope; projectRoot: string | null } {
  const scope = options.scope ?? "user";
  if (scope === "user") return { scope, projectRoot: null };
  if (!options.projectRoot) throw new Error("A project-scoped plugin needs a project root");
  return { scope, projectRoot: resolve(options.projectRoot) };
}

/** Finds the one marketplace publishing `name`, or refuses an ambiguous bare name. */
async function findPublishingMarketplace(name: string, homeDirectory: string): Promise<string> {
  const entries = await listMarketplacePlugins({ homeDirectory });
  const matches = entries.filter((entry) => entry.plugin.name === name).map((entry) => entry.marketplace);
  if (matches.length === 0) throw new Error(`No added marketplace publishes a plugin named '${name}'`);
  if (matches.length > 1) {
    throw new Error(`Plugin '${name}' is published by ${matches.join(", ")}; name it as ${name}@<marketplace>`);
  }
  return matches[0] as string;
}

async function marketplacePluginEntry(
  marketplace: string,
  name: string,
  homeDirectory: string,
): Promise<MarketplacePlugin> {
  const registry = await loadMarketplaceRegistry(homeDirectory);
  if (!registry.marketplaces[marketplace]) throw new Error(`Marketplace '${marketplace}' is not added`);
  const manifest = await readMarketplaceManifest(marketplaceCheckoutPath(marketplace, homeDirectory));
  const plugin = manifest.plugins.find((candidate) => candidate.name === name);
  if (!plugin) throw new Error(`Marketplace '${marketplace}' publishes no plugin named '${name}'`);
  return plugin;
}

/**
 * Everything `/plugin install` must show before fetching: installing a plugin is
 * third-party code execution, so the source, ref, version and sha are resolved
 * and printed first.
 */
export async function planPluginInstall(options: PluginTargetOptions): Promise<PluginInstallPlan> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const { scope, projectRoot } = resolveScope(options);
  const marketplace = options.marketplace ?? await findPublishingMarketplace(options.name, homeDirectory);
  const plugin = await marketplacePluginEntry(marketplace, options.name, homeDirectory);
  const key = pluginKey(plugin.name, marketplace);

  const source = plugin.source;
  const sha = source.type === "directory"
    ? undefined
    : source.sha ?? await resolveRemoteSha(source.url, source.ref);
  const installed = (await loadInstalledPlugins(homeDirectory)).plugins[key] ?? [];
  const replaces = installed.find((record) => record.scope === scope && record.projectRoot === projectRoot);

  return {
    key,
    marketplace,
    plugin,
    scope,
    projectRoot,
    source,
    ...(source.type !== "directory" && source.ref ? { ref: source.ref } : {}),
    ...(sha ? { sha } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(replaces ? { replaces } : {}),
  };
}

/**
 * Fetches the bundle into `cache/<marketplace>/<plugin>/<version>` and records
 * it. The version is the bundle manifest's, else the marketplace entry's, else
 * the 12-character sha; with none of the three the install fails rather than
 * writing an "unknown" directory.
 */
export async function installPlugin(options: PluginTargetOptions): Promise<InstalledPluginRecord> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const plan = await planPluginInstall(options);
  const { marketplace, plugin, scope, projectRoot, source } = plan;

  const staging = join(pluginsDirectory(homeDirectory), "cache", marketplace, plugin.name, `.tmp-${randomUUID()}`);
  await mkdir(join(staging, ".."), { recursive: true, mode: 0o700 });

  let bundleRoot = staging;
  let commitSha = "";
  try {
    if (source.type === "directory") {
      const from = resolveBundleDirectory(marketplaceCheckoutPath(marketplace, homeDirectory), source.path);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await run("cp", ["-R", `${from}/.`, staging], { timeout: GIT_TIMEOUT_MS });
    } else {
      // The plan's sha, so what the confirmation showed is what gets checked out.
      commitSha = await fetchGitTree(source.url, source.ref, plan.sha, staging);
      if (source.path) bundleRoot = resolveBundleDirectory(staging, source.path);
    }

    const manifest = await readPluginManifest(bundleRoot);
    if (manifest?.name && manifest.name !== plugin.name) {
      throw new Error(`Bundle manifest names '${manifest.name}', but the marketplace publishes it as '${plugin.name}'`);
    }
    const version = manifest?.version ?? plugin.version ?? (commitSha ? shortSha(commitSha) : undefined);
    if (!version) {
      throw new Error(`Could not resolve a version for '${plugin.name}': no bundle manifest version, marketplace version, or commit`);
    }

    const destination = pluginCachePath(marketplace, plugin.name, version, homeDirectory);
    await rm(destination, { recursive: true, force: true });
    await rename(bundleRoot, destination);
    if (bundleRoot !== staging) await rm(staging, { recursive: true, force: true });

    const now = new Date().toISOString();
    const registry = await loadInstalledPlugins(homeDirectory);
    const records = (registry.plugins[plan.key] ?? []).filter(
      (record) => !(record.scope === scope && record.projectRoot === projectRoot),
    );
    const record: InstalledPluginRecord = {
      scope,
      projectRoot,
      name: plugin.name,
      marketplace,
      version,
      commitSha,
      source,
      path: pluginCacheRelativePath(marketplace, plugin.name, version),
      installedAt: plan.replaces?.installedAt ?? now,
      updatedAt: now,
    };
    records.push(record);
    records.sort((left, right) => left.scope.localeCompare(right.scope));
    registry.plugins[plan.key] = records;
    await saveInstalledPlugins(registry, homeDirectory);

    if (plan.replaces && plan.replaces.path !== record.path) {
      await discardUnreferencedCache(plan.replaces, registry, homeDirectory);
    }
    return record;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await pruneEmptyCacheDirectories(marketplace, plugin.name, homeDirectory);
    throw error;
  }
}

/** Drops the record for one scope, and the cached bundle once nothing references it. */
export async function uninstallPlugin(options: PluginTargetOptions): Promise<InstalledPluginRecord> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const { scope, projectRoot } = resolveScope(options);
  const registry = await loadInstalledPlugins(homeDirectory);
  const key = options.marketplace
    ? pluginKey(options.name, options.marketplace)
    : installedKeyForName(registry, options.name);

  const records = registry.plugins[key] ?? [];
  const removed = records.find((record) => record.scope === scope && record.projectRoot === projectRoot);
  if (!removed) throw new Error(`Plugin '${key}' is not installed at ${scope} scope`);

  const remaining = records.filter((record) => record !== removed);
  if (remaining.length === 0) delete registry.plugins[key];
  else registry.plugins[key] = remaining;
  await saveInstalledPlugins(registry, homeDirectory);

  await discardUnreferencedCache(removed, registry, homeDirectory);
  return removed;
}

/** The installed key a toggle names; a bare name installed twice is refused. */
export async function installedPluginKey(
  name: string,
  marketplace?: string,
  homeDirectory = homedir(),
): Promise<string> {
  const registry = await loadInstalledPlugins(homeDirectory);
  const key = marketplace ? pluginKey(name, marketplace) : installedKeyForName(registry, name);
  if (!registry.plugins[key]?.length) throw new Error(`Plugin '${key}' is not installed`);
  return key;
}

function installedKeyForName(registry: InstalledPluginRegistry, name: string): string {
  const keys = Object.keys(registry.plugins).filter((key) => key.startsWith(`${name}@`));
  if (keys.length === 0) throw new Error(`Plugin '${name}' is not installed`);
  if (keys.length > 1) throw new Error(`Plugin '${name}' is installed from ${keys.length} marketplaces; name one of ${keys.join(", ")}`);
  return keys[0] as string;
}

/**
 * A cache bundle is shared by every scope installed at that version, so it goes
 * only once no record still points at it. Empty parents go with it, leaving no
 * trace of the uninstalled plugin.
 */
async function discardUnreferencedCache(
  record: InstalledPluginRecord,
  registry: InstalledPluginRegistry,
  homeDirectory: string,
): Promise<void> {
  const stillUsed = Object.values(registry.plugins).some((records) =>
    records.some((candidate) => candidate.path === record.path));
  if (stillUsed) return;
  await rm(pluginCachePath(record.marketplace, record.name, record.version, homeDirectory), { recursive: true, force: true });
  await pruneEmptyCacheDirectories(record.marketplace, record.name, homeDirectory);
}

async function pruneEmptyCacheDirectories(marketplace: string, plugin: string, homeDirectory: string): Promise<void> {
  const cacheRoot = join(pluginsDirectory(homeDirectory), "cache");
  for (const directory of [join(cacheRoot, marketplace, plugin), join(cacheRoot, marketplace)]) {
    try {
      await rmdir(directory);
    } catch {
      return; // Not empty: another version or plugin still lives there.
    }
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Update and check                                                    */
/* ------------------------------------------------------------------ */

/**
 * `local` is a source with no commit to compare - a directory bundle - whose
 * published version still matches; `unavailable` carries the reason nothing
 * could be compared at all.
 */
export type PluginUpdateState = "current" | "drifted" | "local" | "unavailable";

export interface PluginUpdateStatus {
  key: string;
  record: InstalledPluginRecord;
  state: PluginUpdateState;
  /** Version the marketplace names today, when its entry names one. */
  publishedVersion?: string;
  /** Commit the marketplace's source resolves to now; absent for a `directory` source. */
  publishedSha?: string;
  /** Why the state is `unavailable`. */
  reason?: string;
}

export interface PluginUpdateResult {
  status: PluginUpdateStatus;
  previous: InstalledPluginRecord;
  record: InstalledPluginRecord;
  updated: boolean;
}

/** Drift for every installed record, in registry-key order. */
export async function checkPluginUpdates(options: { homeDirectory?: string } = {}): Promise<PluginUpdateStatus[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const registry = await loadInstalledPlugins(homeDirectory);
  const statuses: PluginUpdateStatus[] = [];
  for (const key of Object.keys(registry.plugins).sort()) {
    for (const record of registry.plugins[key] ?? []) {
      statuses.push(await pluginUpdateStatus(key, record, homeDirectory));
    }
  }
  return statuses;
}

/** Drift for the one record a `/plugin update <plugin>` names. */
export async function planPluginUpdate(options: PluginTargetOptions): Promise<PluginUpdateStatus> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const { scope, projectRoot } = resolveScope(options);
  const registry = await loadInstalledPlugins(homeDirectory);
  const key = options.marketplace
    ? pluginKey(options.name, options.marketplace)
    : installedKeyForName(registry, options.name);
  const record = (registry.plugins[key] ?? []).find(
    (candidate) => candidate.scope === scope && candidate.projectRoot === projectRoot,
  );
  if (!record) throw new Error(`Plugin '${key}' is not installed at ${scope} scope`);
  return pluginUpdateStatus(key, record, homeDirectory);
}

/**
 * Re-installs a drifted plugin from its marketplace. The registry key never
 * changes, so enable state and the `<plugin>:` skill namespace survive; an
 * up-to-date plugin is left alone rather than refetched.
 */
export async function updatePlugin(options: PluginTargetOptions): Promise<PluginUpdateResult> {
  const status = await planPluginUpdate(options);
  if (status.state === "unavailable") throw new Error(status.reason ?? `Plugin '${status.key}' cannot be updated`);
  if (status.state !== "drifted") {
    return { status, previous: status.record, record: status.record, updated: false };
  }
  const record = await installPlugin({ ...options, marketplace: status.record.marketplace });
  return { status, previous: status.record, record, updated: true };
}

async function pluginUpdateStatus(
  key: string,
  record: InstalledPluginRecord,
  homeDirectory: string,
): Promise<PluginUpdateStatus> {
  const unavailable = (reason: string): PluginUpdateStatus => ({ key, record, state: "unavailable", reason });

  const marketplaces = await loadMarketplaceRegistry(homeDirectory);
  if (!marketplaces.marketplaces[record.marketplace]) {
    return unavailable(`Marketplace '${record.marketplace}' is no longer added, so '${key}' cannot be compared`);
  }

  let entry: MarketplacePlugin;
  try {
    entry = await marketplacePluginEntry(record.marketplace, record.name, homeDirectory);
  } catch (error) {
    return unavailable(errorText(error));
  }

  let publishedSha: string | undefined;
  if (entry.source.type !== "directory") {
    try {
      publishedSha = entry.source.sha ?? await resolveRemoteSha(entry.source.url, entry.source.ref);
    } catch (error) {
      return unavailable(`Could not resolve the published commit of '${key}': ${errorText(error)}`);
    }
  }

  const published = {
    ...(entry.version ? { publishedVersion: entry.version } : {}),
    ...(publishedSha ? { publishedSha } : {}),
  };
  // An empty recorded sha means a directory install; a published sha against it
  // is a source that changed kind, which is drift.
  const drifted = (publishedSha !== undefined && publishedSha !== record.commitSha)
    || (entry.version !== undefined && entry.version !== record.version);
  if (drifted) return { key, record, state: "drifted", ...published };
  const state: PluginUpdateState = publishedSha === undefined && !record.commitSha ? "local" : "current";
  return { key, record, state, ...published };
}

export interface MarketplaceUpdateResult {
  name: string;
  previousSha?: string;
  commitSha?: string;
  /** A `directory` marketplace has no commit, so it is never reported as changed. */
  changed: boolean;
  plugins: number;
}

/** Refetches a marketplace checkout so drift against it is measured against what is published now. */
export async function updateMarketplace(name: string, homeDirectory = homedir()): Promise<MarketplaceUpdateResult> {
  const registry = await loadMarketplaceRegistry(homeDirectory);
  const record = registry.marketplaces[name];
  if (!record) throw new Error(`Marketplace '${name}' is not added`);

  const scratch = join(pluginsDirectory(homeDirectory), "marketplaces", `.probe-${randomUUID()}`);
  let manifest: MarketplaceManifest;
  let commitSha: string | undefined;
  try {
    commitSha = await fetchMarketplace(record.source, scratch);
    manifest = await readMarketplaceManifest(scratch);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }

  // The old checkout goes only once the new one is in hand and parses.
  const destination = marketplaceCheckoutPath(name, homeDirectory);
  await rm(destination, { recursive: true, force: true });
  await rename(scratch, destination);

  const previousSha = record.commitSha;
  registry.marketplaces[name] = {
    ...record,
    lastFetchedAt: new Date().toISOString(),
    ...(commitSha ? { commitSha } : {}),
  };
  await saveMarketplaceRegistry(registry, homeDirectory);

  return {
    name,
    ...(previousSha ? { previousSha } : {}),
    ...(commitSha ? { commitSha } : {}),
    changed: commitSha !== undefined && commitSha !== previousSha,
    plugins: manifest.plugins.length,
  };
}

/** Refetches one named marketplace, or every added one. */
export async function updateMarketplaces(name: string | undefined, homeDirectory = homedir()): Promise<MarketplaceUpdateResult[]> {
  if (name) return [await updateMarketplace(name, homeDirectory)];
  const registry = await loadMarketplaceRegistry(homeDirectory);
  const results: MarketplaceUpdateResult[] = [];
  for (const marketplace of Object.keys(registry.marketplaces).sort()) {
    results.push(await updateMarketplace(marketplace, homeDirectory));
  }
  return results;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/** One installed bundle a session may take skills and commands from. */
export interface PluginBundle {
  /** `<plugin>@<marketplace>`, the plugin's identity everywhere else. */
  key: string;
  name: string;
  /** Absolute bundle root in the cache. */
  bundle: string;
}

export interface PluginBundleOptions {
  /** Session working directory; decides which project-scoped records apply. */
  cwd: string;
  homeDirectory?: string;
  enabledPlugins?: Record<string, boolean>;
}

/** A key absent from the table means enabled, so a fresh install needs no write. */
export function isPluginEnabled(key: string, enabledPlugins?: Record<string, boolean>): boolean {
  return enabledPlugins?.[key] !== false;
}

/**
 * Installed and enabled bundles visible to a session, in registry-key order. A
 * record whose cache directory is gone is skipped with a warning rather than
 * failing the session.
 */
export async function enabledPluginBundles(options: PluginBundleOptions): Promise<PluginBundle[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const registry = await loadInstalledPlugins(homeDirectory);
  const root = pluginsDirectory(homeDirectory);
  const bundles: PluginBundle[] = [];
  for (const key of Object.keys(registry.plugins).sort()) {
    if (!isPluginEnabled(key, options.enabledPlugins)) continue;
    const record = applicableRecord(registry.plugins[key] ?? [], options.cwd);
    if (!record) continue;
    const bundle = join(root, record.path);
    if (!existsSync(bundle)) {
      warnMissingBundle(key, bundle);
      continue;
    }
    bundles.push({ key, name: record.name, bundle });
  }
  return bundles;
}

/** The project record wins over the user one when the session sits inside it. */
function applicableRecord(records: InstalledPluginRecord[], cwd: string): InstalledPluginRecord | undefined {
  const project = records.find((record) =>
    record.scope === "project" && record.projectRoot != null && isWithin(record.projectRoot, cwd));
  return project ?? records.find((record) => record.scope === "user");
}

function isWithin(root: string, directory: string): boolean {
  const relativePath = relative(root, directory);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

const reportedMissingBundles = new Set<string>();

function warnMissingBundle(key: string, bundle: string): void {
  if (reportedMissingBundles.has(bundle)) return;
  reportedMissingBundles.add(bundle);
  console.error(`amber: plugin ${key} is installed but its bundle is missing at ${bundle}`);
}

/** One user-scope install as the settings modal shows it. */
export interface UserPluginState {
  /** `<plugin>@<marketplace>`, the key the enable table and every toggle use. */
  key: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
}

/**
 * User-scope installs in key order, taken from the registry rather than from
 * the enable table, so a plugin that has never been toggled is still listed -
 * reading as enabled, because an absent key means enabled.
 */
export function userPluginStates(
  registry: InstalledPluginRegistry,
  enabledPlugins?: Record<string, boolean>,
): UserPluginState[] {
  const plugins: UserPluginState[] = [];
  for (const key of Object.keys(registry.plugins).sort()) {
    const record = (registry.plugins[key] ?? []).find((candidate) => candidate.scope === "user");
    if (!record) continue;
    plugins.push({
      key,
      name: record.name,
      marketplace: record.marketplace,
      version: record.version,
      enabled: isPluginEnabled(key, enabledPlugins),
    });
  }
  return plugins;
}

/** Keys carrying a project-scope record, which only `/plugin --project` governs. */
export function projectPluginKeys(registry: InstalledPluginRegistry): string[] {
  return Object.keys(registry.plugins)
    .filter((key) => (registry.plugins[key] ?? []).some((record) => record.scope === "project"))
    .sort();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderMarketplaceList(registry: MarketplaceRegistry): string {
  const names = Object.keys(registry.marketplaces).sort();
  if (names.length === 0) {
    return [
      "**Plugin marketplaces**",
      "",
      "No marketplaces added.",
      "",
      "Add one with `/plugin marketplace add anthropics/claude-plugins-official`.",
    ].join("\n");
  }
  return ["**Plugin marketplaces**", "", ...names.map((name) => {
    const record = registry.marketplaces[name] as MarketplaceRecord;
    const where = record.source.type === "directory" ? record.source.path : record.source.url;
    const details = [
      record.source.type === "url" && record.source.ref ? `ref \`${record.source.ref}\`` : undefined,
      record.commitSha ? `\`${record.commitSha.slice(0, 12)}\`` : undefined,
    ].filter(Boolean).join(" · ");
    return `- **${name}** — ${where}${details ? ` (${details})` : ""}`;
  })].join("\n");
}

export function renderPluginOverview(registry: MarketplaceRegistry): string {
  return [
    renderMarketplaceList(registry),
    "",
    "**Commands**",
    "",
    "- `/plugin marketplace add <owner/repo | url | directory> [as <name>]`",
    "- `/plugin marketplace remove <name>`",
    "- `/plugin marketplace list`",
    "- `/plugin marketplace update [name]`",
    "- `/plugin list [marketplace]`",
    "- `/plugin installed`",
    "- `/plugin install <plugin>[@marketplace] [--project] [--yes]`",
    "- `/plugin update [<plugin>[@marketplace]] [--project] [--yes]`",
    "- `/plugin uninstall <plugin>[@marketplace] [--project]`",
    "- `/plugin enable <plugin>[@marketplace] [--project]`",
    "- `/plugin disable <plugin>[@marketplace] [--project]`",
  ].join("\n");
}

/**
 * The confirmation an install is gated on. A plugin skill runs shell with the
 * user's privileges, so the exact source, ref, version and commit are shown
 * before anything is fetched.
 */
export function renderPluginInstallPlan(plan: PluginInstallPlan): string {
  const where = plan.source.type === "directory" ? plan.source.path : plan.source.url;
  const subdirectory = plan.source.type !== "directory" ? plan.source.path : undefined;
  return [
    `**Install \`${plan.key}\`?**`,
    "",
    `- Source: \`${where}\` (${plan.source.type})`,
    ...(subdirectory ? [`- Subdirectory: \`${subdirectory}\``] : []),
    ...(plan.ref ? [`- Ref: \`${plan.ref}\``] : []),
    ...(plan.sha ? [`- Commit: \`${plan.sha}\``] : []),
    `- Version: ${plan.version ? `\`${plan.version}\`` : "resolved at install time from the bundle manifest, else the commit"}`,
    `- Scope: ${plan.scope}${plan.projectRoot ? ` (\`${plan.projectRoot}\`)` : ""}`,
    ...(plan.replaces ? [`- Replaces the installed \`${plan.replaces.version}\``] : []),
    "",
    "A plugin's skills run shell commands with your privileges. Install only from a source you trust.",
    "",
    `Run \`/plugin install ${plan.key}${plan.scope === "project" ? " --project" : ""} --yes\` to install.`,
  ].join("\n");
}

export function renderPluginInstalled(record: InstalledPluginRecord): string {
  return [
    `Installed **${pluginKey(record.name, record.marketplace)}** \`${record.version}\` at ${record.scope} scope.`,
    "",
    ...(record.commitSha ? [`- Commit: \`${record.commitSha}\``] : []),
    `- Cache: \`${record.path}\``,
    "",
    "It is enabled by default and contributes its skills to new sessions.",
  ].join("\n");
}

export function renderInstalledPlugins(
  registry: InstalledPluginRegistry,
  enabledPlugins?: Record<string, boolean>,
): string {
  const keys = Object.keys(registry.plugins).sort();
  if (keys.length === 0) {
    return ["**Installed plugins**", "", "No plugins installed.", "", "Install one with `/plugin install <plugin>`."].join("\n");
  }
  const lines = ["**Installed plugins**", ""];
  for (const key of keys) {
    for (const record of registry.plugins[key] ?? []) {
      const commit = record.commitSha ? ` · \`${shortSha(record.commitSha)}\`` : "";
      const scope = record.scope === "project" ? ` · project \`${record.projectRoot}\`` : "";
      const state = isPluginEnabled(key, enabledPlugins) ? "" : " _(disabled)_";
      lines.push(`- **${key}** \`${record.version}\`${commit}${scope}${state}`);
    }
  }
  return lines.join("\n");
}

export function renderPluginUpdateReport(statuses: PluginUpdateStatus[]): string {
  if (statuses.length === 0) {
    return ["**Plugin updates**", "", "No plugins installed."].join("\n");
  }
  const lines = ["**Plugin updates**", ""];
  for (const status of statuses) {
    const scope = status.record.scope === "project" ? ` · project \`${status.record.projectRoot}\`` : "";
    lines.push(`- **${status.key}** \`${status.record.version}\`${scope} — ${updateSummary(status)}`);
  }
  const drifted = statuses.filter((status) => status.state === "drifted");
  if (drifted.length > 0) {
    lines.push("", `Apply one with \`/plugin update ${drifted[0]?.key}${drifted[0]?.record.scope === "project" ? " --project" : ""} --yes\`.`);
  }
  return lines.join("\n");
}

function updateSummary(status: PluginUpdateStatus): string {
  if (status.state === "unavailable") return status.reason ?? "cannot be compared";
  if (status.state === "local") return "local source, nothing to compare";
  if (status.state === "current") return "up to date";
  const moved = [
    status.publishedVersion && status.publishedVersion !== status.record.version
      ? `\`${status.record.version}\` → \`${status.publishedVersion}\`` : undefined,
    status.publishedSha && status.publishedSha !== status.record.commitSha
      ? `\`${shortSha(status.record.commitSha) || "none"}\` → \`${shortSha(status.publishedSha)}\`` : undefined,
  ].filter(Boolean).join(" · ");
  return `update available: ${moved}`;
}

/**
 * What `/plugin update <plugin>` shows before it fetches: an update runs
 * whatever the new commit brings, so the old and new commit are shown first.
 */
export function renderPluginUpdatePlan(status: PluginUpdateStatus): string {
  if (status.state !== "drifted") {
    return `**${status.key}** \`${status.record.version}\` — ${updateSummary(status)}`;
  }
  const source = status.record.source;
  const where = source.type === "directory" ? source.path : source.url;
  return [
    `**Update \`${status.key}\`?**`,
    "",
    `- Source: \`${where}\` (${source.type})`,
    `- Installed: \`${status.record.version}\`${status.record.commitSha ? ` · \`${status.record.commitSha}\`` : ""}`,
    `- Published: ${status.publishedVersion ? `\`${status.publishedVersion}\`` : "version from the bundle manifest at update time"}${status.publishedSha ? ` · \`${status.publishedSha}\`` : ""}`,
    `- Scope: ${status.record.scope}${status.record.projectRoot ? ` (\`${status.record.projectRoot}\`)` : ""}`,
    "",
    "A plugin's skills run shell commands with your privileges. Update only from a source you trust.",
    "",
    `Run \`/plugin update ${status.key}${status.record.scope === "project" ? " --project" : ""} --yes\` to apply.`,
  ].join("\n");
}

export function renderPluginUpdated(result: PluginUpdateResult): string {
  if (!result.updated) return `**${result.status.key}** \`${result.record.version}\` — ${updateSummary(result.status)}`;
  return [
    `Updated **${result.status.key}** \`${result.previous.version}\` → \`${result.record.version}\`.`,
    "",
    ...(result.record.commitSha
      ? [`- Commit: \`${shortSha(result.previous.commitSha) || "none"}\` → \`${shortSha(result.record.commitSha)}\``]
      : []),
    `- Cache: \`${result.record.path}\``,
    "",
    "Its enable state and skill namespace are unchanged.",
  ].join("\n");
}

export function renderMarketplaceUpdate(results: MarketplaceUpdateResult[]): string {
  if (results.length === 0) {
    return ["**Marketplaces**", "", "No marketplaces added."].join("\n");
  }
  return ["**Marketplaces**", "", ...results.map((result) => {
    const moved = !result.commitSha
      ? " · re-read" // A directory marketplace has no commit to compare.
      : result.changed
        ? ` · \`${result.previousSha ? shortSha(result.previousSha) : "none"}\` → \`${shortSha(result.commitSha)}\``
        : " · unchanged";
    return `- **${result.name}** — ${result.plugins} published plugin(s)${moved}`;
  }), "", "Check installed plugins for drift with `/plugin update`."].join("\n");
}

export function renderPluginList(entries: MarketplacePluginEntry[]): string {
  if (entries.length === 0) {
    return ["**Plugins**", "", "No plugins published by the added marketplaces."].join("\n");
  }
  const lines: string[] = [];
  for (const marketplace of [...new Set(entries.map((entry) => entry.marketplace))]) {
    lines.push(`**${marketplace}**`, "");
    for (const entry of entries.filter((candidate) => candidate.marketplace === marketplace)) {
      const status = entry.installed ? "installed" : "not installed";
      const version = entry.plugin.version ? ` \`${entry.plugin.version}\`` : "";
      lines.push(`- **${entry.plugin.name}**${version} — ${entry.plugin.description} _(${status})_`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function readJsonFile(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<string> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Manifests write an author or owner as either a bare string or `{ name }`. */
function personName(value: unknown): string | undefined {
  if (typeof value === "string") return optionalString(value);
  if (isRecord(value)) return optionalString(value.name);
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
