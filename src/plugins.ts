import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

export type PluginCommand =
  | { kind: "overview" }
  | { kind: "marketplace-list" }
  | { kind: "marketplace-add"; spec: string; alias?: string }
  | { kind: "marketplace-remove"; name: string }
  | { kind: "list"; marketplace?: string }
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
    return { kind: "error", message: `Unknown marketplace action: ${action}` };
  }

  if (head === "list") {
    const marketplace = rest[0];
    if (rest.length === 0) return { kind: "list" };
    if (rest.length === 1 && marketplace) return { kind: "list", marketplace };
    return { kind: "error", message: "Usage: /plugin list [marketplace]" };
  }

  return { kind: "error", message: `Unknown /plugin action: ${head}` };
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

/** Registry keys (`<plugin>@<marketplace>`) of installed plugins; step 3 writes this file. */
export async function loadInstalledPluginKeys(homeDirectory = homedir()): Promise<Set<string>> {
  const parsed = await readJsonFile(join(pluginsDirectory(homeDirectory), "installed_plugins.json"));
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return new Set();
  return new Set(Object.keys(parsed.plugins));
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
  const installed = await loadInstalledPluginKeys(homeDirectory);

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
    "- `/plugin list [marketplace]`",
  ].join("\n");
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
