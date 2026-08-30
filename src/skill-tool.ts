import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseShellArguments } from "./shell-quote.js";
import ignoreFactory from "./ignore.js";
import { parse as parseYaml } from "yaml";
import { BashExecutor, DEFAULT_BASH_TIMEOUT_MS } from "./bash-tool.js";
import type { ThinkingLevel, ToolDefinition } from "./types.js";

export const SKILL_TOOL_NAME = "Skill";

const SKILL_TOOL_DESCRIPTION = `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`;

export const SKILL_TOOL: ToolDefinition = {
  name: SKILL_TOOL_NAME,
  description: SKILL_TOOL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      skill: { type: "string", description: 'The skill name. E.g., "commit", "review-pr", or "pdf"' },
      args: { type: "string", description: "Optional arguments for the skill" },
    },
    required: ["skill"],
    additionalProperties: false,
  },
};

/** A single discovered skill (a `<name>/SKILL.md` directory or a legacy command markdown file). */
export interface SkillDefinition {
  /** Invocation name; legacy commands nested in directories are `:`-namespaced. */
  name: string;
  displayName: string | undefined;
  description: string;
  hasUserSpecifiedDescription: boolean;
  allowedTools: string[];
  argumentNames: string[];
  argumentHint: string | undefined;
  whenToUse: string | undefined;
  version: string | undefined;
  model: string | undefined;
  effort: ThinkingLevel | undefined;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  fork: boolean;
  agent: string | undefined;
  paths: string[] | undefined;
  shell: "bash" | "powershell" | undefined;
  /** Markdown body with the frontmatter block removed. */
  content: string;
  /** Directory of a `<name>/SKILL.md` skill; undefined for flat command files. */
  basePath: string | undefined;
  filePath: string;
  realPath: string;
}

export interface SkillDiscoveryContext {
  /** Session working directory. */
  cwd: string;
  homeDirectory: string;
  /** `/add-dir` roots for the session. */
  addDirRoots?: string[];
  /** Nested project directories discovered from touched files. */
  extraProjectRoots?: string[];
  /** Project paths touched this session, used to activate `paths:`-gated skills. */
  touchedPaths?: string[];
}

interface SkillDirectoryUnit {
  directory: string;
  kind: "skills" | "commands";
}

const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESC_CHARS = 250;
const MIN_DESC_LENGTH = 20;
const MAX_SHELL_OUTPUT_CHARACTERS = 20_000;
const MAX_REINJECTED_SKILL_CHARACTERS = 20_000;

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

function gitRoot(directory: string): string | undefined {
  let candidate = directory;
  for (;;) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/** Directories from `start` up to and including the git root, deepest first. */
function ancestorsThroughGitRoot(start: string): string[] {
  const root = gitRoot(start) ?? start;
  const directories: string[] = [];
  for (let candidate = start; ; candidate = dirname(candidate)) {
    directories.push(candidate);
    if (candidate === root) break;
    const parent = dirname(candidate);
    if (parent === candidate) break;
  }
  return directories;
}

function skillDirectoryUnits(context: SkillDiscoveryContext): SkillDirectoryUnit[] {
  const project = ancestorsThroughGitRoot(context.cwd);
  const nested = context.extraProjectRoots ?? [];
  const added = context.addDirRoots ?? [];
  const amberProject: SkillDirectoryUnit[] = [
    ...nested.flatMap((directory): SkillDirectoryUnit[] => [
      { directory: join(directory, ".amber", "skills"), kind: "skills" },
      { directory: join(directory, ".amber", "commands"), kind: "commands" },
    ]),
    ...project.flatMap((directory): SkillDirectoryUnit[] => [
      { directory: join(directory, ".amber", "skills"), kind: "skills" },
      { directory: join(directory, ".amber", "commands"), kind: "commands" },
    ]),
    ...added.flatMap((directory): SkillDirectoryUnit[] => [
      { directory: join(directory, ".amber", "skills"), kind: "skills" },
      { directory: join(directory, ".amber", "commands"), kind: "commands" },
    ]),
  ];
  const claudeProject: SkillDirectoryUnit[] = [
    ...nested.flatMap((directory): SkillDirectoryUnit[] => [
      { directory: join(directory, ".claude", "skills"), kind: "skills" },
      { directory: join(directory, ".claude", "commands"), kind: "commands" },
    ]),
    ...project.flatMap((directory): SkillDirectoryUnit[] => [
      { directory: join(directory, ".claude", "skills"), kind: "skills" },
      { directory: join(directory, ".claude", "commands"), kind: "commands" },
    ]),
  ];
  return [
    ...amberProject,
    { directory: join(context.homeDirectory, ".amber", "skills"), kind: "skills" },
    { directory: join(context.homeDirectory, ".amber", "commands"), kind: "commands" },
    ...claudeProject,
    { directory: join(context.homeDirectory, ".claude", "skills"), kind: "skills" },
    { directory: join(context.homeDirectory, ".claude", "commands"), kind: "commands" },
  ];
}

/**
 * Discovers every skill visible to a session, in precedence order: Amber project
 * paths (deepest CWD ancestor first, then nested roots, then /add-dir roots),
 * the Amber user directory, and finally the Claude-compatible equivalents.
 */
export async function discoverSkills(context: SkillDiscoveryContext): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  const seenRealPaths = new Set<string>();
  const seenNames = new Set<string>();
  for (const unit of skillDirectoryUnits(context)) {
    const found = unit.kind === "skills"
      ? await loadSkillsDirectory(unit.directory)
      : await loadCommandsDirectory(unit.directory);
    for (const skill of found) {
      if (seenRealPaths.has(skill.realPath) || seenNames.has(skill.name)) continue;
      seenRealPaths.add(skill.realPath);
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

/**
 * Nested project directories (between a touched file and the project root) that
 * define their own skills. Walking stops at, but excludes, the project root.
 */
export async function discoverNestedProjectRoots(filePath: string, projectRoot?: string): Promise<string[]> {
  const root = projectRoot ?? gitRoot(dirname(filePath)) ?? dirname(filePath);
  const roots: string[] = [];
  for (let candidate = dirname(filePath); ; candidate = dirname(candidate)) {
    if (candidate === root || candidate === dirname(candidate)) break;
    if (await hasSkillDirectory(candidate)) roots.push(candidate);
  }
  return roots;
}

async function hasSkillDirectory(directory: string): Promise<boolean> {
  return await someExist([
    join(directory, ".amber", "skills"),
    join(directory, ".amber", "commands"),
    join(directory, ".claude", "skills"),
    join(directory, ".claude", "commands"),
  ]);
}

async function someExist(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }))).some(Boolean);
}

async function loadSkillsDirectory(directory: string): Promise<SkillDefinition[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = await Promise.all(entries.map(async (entry): Promise<SkillDefinition | undefined> => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return undefined;
    const skillDirectory = join(directory, entry.name);
    const filePath = join(skillDirectory, "SKILL.md");
    const loaded = await loadSkillFile(filePath, entry.name, skillDirectory);
    return loaded;
  }));
  return found.filter((skill): skill is SkillDefinition => skill !== undefined);
}

interface MarkdownFile {
  filePath: string;
  baseDirectory: string;
}

async function loadCommandsDirectory(directory: string): Promise<SkillDefinition[]> {
  const files = await collectMarkdownFiles(directory, directory);
  const byDirectory = new Map<string, MarkdownFile[]>();
  for (const file of files) {
    const group = byDirectory.get(dirname(file.filePath)) ?? [];
    group.push(file);
    byDirectory.set(dirname(file.filePath), group);
  }
  const selected: MarkdownFile[] = [];
  for (const group of byDirectory.values()) {
    const skillFiles = group.filter((file) => isSkillFileName(file.filePath));
    selected.push(...(skillFiles.length > 0 ? [skillFiles[0]!] : group));
  }
  const skills: SkillDefinition[] = [];
  for (const file of selected) {
    const skill = isSkillFileName(file.filePath)
      ? await loadSkillFile(file.filePath, commandName(file.filePath, file.baseDirectory), dirname(file.filePath))
      : await loadSkillFile(file.filePath, commandName(file.filePath, file.baseDirectory), undefined);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function collectMarkdownFiles(directory: string, baseDirectory: string): Promise<MarkdownFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: MarkdownFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      files.push(...await collectMarkdownFiles(path, baseDirectory));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push({ filePath: path, baseDirectory });
    }
  }
  return files;
}

function isSkillFileName(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath));
}

function commandName(filePath: string, baseDirectory: string): string {
  const skillDirectory = dirname(filePath);
  const namespaceBase = isSkillFileName(filePath) ? dirname(skillDirectory) : skillDirectory;
  const commandBase = isSkillFileName(filePath)
    ? basename(skillDirectory)
    : basename(filePath).replace(/\.md$/i, "");
  const prefix = directoryNamespace(namespaceBase, baseDirectory);
  return prefix ? `${prefix}:${commandBase}` : commandBase;
}

function directoryNamespace(target: string, base: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (target === normalizedBase) return "";
  const relativePath = relative(normalizedBase, target);
  return relativePath ? relativePath.split("/").join(":") : "";
}

async function loadSkillFile(
  filePath: string,
  name: string,
  basePath: string | undefined,
): Promise<SkillDefinition | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const realPath = await realpath(filePath).catch(() => filePath);
  const { frontmatter, content } = parseFrontmatter(text);
  const description = coerceDescription(frontmatter.description)
    ?? descriptionFromMarkdown(content, "Skill");
  return {
    name,
    displayName: frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: coerceDescription(frontmatter.description) !== null,
    allowedTools: parseToolList(frontmatter["allowed-tools"]),
    argumentNames: parseArgumentNames(frontmatter.arguments),
    argumentHint: frontmatter["argument-hint"] != null ? String(frontmatter["argument-hint"]) : undefined,
    whenToUse: typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use : undefined,
    version: typeof frontmatter.version === "string" ? frontmatter.version : undefined,
    model: frontmatter.model === "inherit" || frontmatter.model == null
      ? undefined
      : String(frontmatter.model),
    effort: parseEffort(frontmatter.effort),
    disableModelInvocation: parseBoolean(frontmatter["disable-model-invocation"]),
    userInvocable: frontmatter["user-invocable"] === undefined
      ? true
      : parseBoolean(frontmatter["user-invocable"]),
    fork: frontmatter.context === "fork",
    agent: typeof frontmatter.agent === "string" ? frontmatter.agent : undefined,
    paths: parseSkillPaths(frontmatter.paths),
    shell: frontmatter.shell === "powershell" ? "powershell" : frontmatter.shell === "bash" ? "bash" : undefined,
    content,
    basePath,
    filePath,
    realPath,
  };
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

interface FrontmatterData {
  [key: string]: unknown;
}

function parseFrontmatter(text: string): { frontmatter: FrontmatterData; content: string } {
  if (!text.startsWith("---")) return { frontmatter: {}, content: text };
  const lines = text.split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (closing <= 0) return { frontmatter: {}, content: text };
  return {
    frontmatter: parseFrontmatterBlock(lines.slice(1, closing).join("\n")),
    content: lines.slice(closing + 1).join("\n").replace(/^\n+/, ""),
  };
}

function parseFrontmatterBlock(block: string): FrontmatterData {
  try {
    return asRecord(parseYaml(block));
  } catch {
    // Bare scalars such as `argument-hint: [left] [right]` are not valid YAML.
    // Retry quoting only the values that are invalid on their own so flow-style
    // lists and other valid YAML survive untouched.
    const quoted = block.split("\n").map((line) => {
      const match = line.match(/^(\s*[\w.-]+:)(.*)$/);
      if (!match) return line;
      const value = (match[2] ?? "").trim();
      if (!value || isValidYamlScalar(`${match[1]} ${value}`)) return line;
      return `${match[1]} ${JSON.stringify(value)}`;
    }).join("\n");
    try {
      return asRecord(parseYaml(quoted));
    } catch {
      return {};
    }
  }
}

function isValidYamlScalar(mapping: string): boolean {
  try {
    parseYaml(mapping);
    return true;
  } catch {
    return false;
  }
}

function asRecord(parsed: unknown): FrontmatterData {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as FrontmatterData : {};
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function coerceDescription(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function descriptionFromMarkdown(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = trimmed.match(/^#+\s+(.+)$/);
    const text = header?.[1] ?? trimmed;
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  }
  return fallback;
}

function parseToolList(value: unknown): string[] {
  if (value == null) return [];
  const list = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[\s,]+/).filter(Boolean)
      : [];
  return list.includes("*") ? ["*"] : list;
}

const EFFORT_LEVELS: readonly ThinkingLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

function parseEffort(value: unknown): ThinkingLevel | undefined {
  if (value == null) return undefined;
  const text = String(value).trim().toLowerCase();
  return EFFORT_LEVELS.includes(text as ThinkingLevel) ? text as ThinkingLevel : undefined;
}

/** Comma-separated (or YAML list) gitignore-style patterns, with brace expansion. */
export function parseSkillPaths(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const raw = Array.isArray(value)
    ? value.flatMap((item) => splitPatterns(String(item)))
    : typeof value === "string"
      ? splitPatterns(value)
      : [];
  const patterns = raw
    .map((pattern) => (pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern))
    .filter((pattern) => pattern.length > 0);
  if (patterns.length === 0 || patterns.every((pattern) => pattern === "**")) return undefined;
  return patterns;
}

function splitPatterns(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of input) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.flatMap((pattern) => expandBraces(pattern));
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (!match) return [pattern];
  const [, prefix = "", alternatives = "", suffix = ""] = match;
  return alternatives.split(",").flatMap((alternative) => expandBraces(`${prefix}${alternative.trim()}${suffix}`));
}

/** Whether a `paths:`-gated skill is active for the paths touched this session. */
export function isSkillPathActive(skill: SkillDefinition, touchedPaths: readonly string[], cwd: string): boolean {
  if (!skill.paths) return true;
  if (touchedPaths.length === 0) return false;
  const matcher = ignoreFactory().add(skill.paths);
  return touchedPaths.some((touched) => {
    const relativePath = relative(cwd, touched);
    // `ignore` rejects absolute paths, so paths outside the session directory
    // can only match through their basename.
    return relativePath.startsWith("..") ? matcher.ignores(basename(touched)) : matcher.ignores(relativePath);
  });
}

/* ------------------------------------------------------------------ */
/* Invocation                                                          */
/* ------------------------------------------------------------------ */

export function normalizeSkillName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

export type ResolvedSkill = { skill: SkillDefinition } | { error: string };

export function resolveSkill(
  skills: readonly SkillDefinition[],
  raw: string,
  touchedPaths: readonly string[] = [],
  cwd = process.cwd(),
): ResolvedSkill {
  const name = normalizeSkillName(raw);
  if (!name) return { error: `Invalid skill format: ${raw}` };
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) return { error: `Unknown skill: ${name}` };
  if (skill.disableModelInvocation) {
    return { error: `Skill ${name} cannot be used with the Skill tool due to disable-model-invocation` };
  }
  if (skill.fork) return { error: `Skill ${name} uses context: fork, which Amber does not support` };
  if (!isSkillPathActive(skill, touchedPaths, cwd)) {
    return { error: `Skill ${name} is not active for the paths touched in this session` };
  }
  return { skill };
}

/** Skills the model may invoke and that should appear in the skill listing. */
export function invocableSkills(
  skills: readonly SkillDefinition[],
  touchedPaths: readonly string[] = [],
  cwd = process.cwd(),
): SkillDefinition[] {
  return skills.filter((skill) =>
    !skill.disableModelInvocation && !skill.fork && isSkillPathActive(skill, touchedPaths, cwd));
}

export function parseSkillInput(input: Record<string, unknown>): { skill: string; args: string | undefined } {
  const skill = typeof input.skill === "string" ? input.skill : "";
  const args = typeof input.args === "string" ? input.args : undefined;
  if (!skill.trim()) throw new Error("Skill requires a non-empty skill name");
  if (input.args !== undefined && typeof input.args !== "string") throw new Error("Skill args must be a string");
  return { skill, args };
}

/**
 * Resolves a skill's `model:` frontmatter against the catalog. Accepts an exact
 * `provider/model` key, or a bare model id when it is globally unique. Missing or
 * ambiguous values return undefined so the session model is inherited.
 */
export function resolveSkillModel(
  model: string | undefined,
  available: readonly { key: string; model: string }[],
): string | undefined {
  if (!model) return undefined;
  if (available.some((candidate) => candidate.key === model)) return model;
  const matches = available.filter((candidate) => candidate.model === model);
  return matches.length === 1 ? matches[0]!.key : undefined;
}

export interface SkillExpansionOptions {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** Overrides shell execution, for tests. */
  runCommand?: (command: string, shell: "bash" | "powershell") => Promise<string>;
}

export interface ExpandedSkill {
  name: string;
  content: string;
  model: string | undefined;
  effort: ThinkingLevel | undefined;
}

const MAX_SKILL_PREVIEW_CHARACTERS = 2_000;

/**
 * Card preview of an expanded skill: the full prompt is injected into the
 * conversation separately, so only a capped excerpt is shown to the user.
 */
export function skillInvocationPreview(content: string): string {
  const text = content.trim();
  return text.length <= MAX_SKILL_PREVIEW_CHARACTERS
    ? text
    : `${text.slice(0, MAX_SKILL_PREVIEW_CHARACTERS)}\n… [truncated]`;
}

/**
 * Builds the model-visible skill prompt: base-directory note, argument and
 * environment placeholders, then embedded shell substitutions. Only shell
 * patterns authored in the skill body are executed, so argument values can
 * never introduce commands of their own.
 */
export async function expandSkill(
  skill: SkillDefinition,
  args: string | undefined,
  options: SkillExpansionOptions,
): Promise<ExpandedSkill> {
  const baseDirectory = skill.basePath ? skill.basePath.replace(/\\/g, "/") : undefined;
  const authored = baseDirectory ? `Base directory for this skill: ${baseDirectory}\n\n${skill.content}` : skill.content;
  const patterns = shellPatterns(authored).map((pattern) => ({
    raw: substituteArguments(pattern.raw, args, false, skill.argumentNames),
    command: substituteArguments(pattern.command, args, false, skill.argumentNames),
  }));

  let content = substituteArguments(authored, args, true, skill.argumentNames);
  if (baseDirectory) {
    content = content.replace(/\$\{(?:CLAUDE|AMBER)_SKILL_DIR\}/g, baseDirectory);
  }
  content = content.replace(/\$\{(?:CLAUDE|AMBER)_SESSION_ID\}/g, options.sessionId);

  const selected = skill.shell ?? "bash";
  const outputs = await Promise.all(patterns.map((pattern) => runSkillShell(pattern.command, selected, options)));
  content = replacePatterns(content, patterns.map((pattern) => pattern.raw), outputs);

  return { name: skill.name, content, model: skill.model, effort: skill.effort };
}

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

export function parseSkillArguments(args: string): string[] {
  if (!args.trim()) return [];
  let tokens: unknown[];
  try {
    tokens = parseShellArguments(args, (key: string) => `$${key}`) as unknown[];
  } catch {
    return args.split(/\s+/).filter(Boolean);
  }
  return tokens.filter((token): token is string => typeof token === "string");
}

export function parseArgumentNames(value: unknown): string[] {
  if (!value) return [];
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/\s+/) : [];
  return candidates.filter((name): name is string => typeof name === "string" && name.trim() !== "" && !/^\d+$/.test(name));
}

export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: readonly string[] = [],
): string {
  if (args === undefined || args === null) return content;
  const parsed = parseSkillArguments(args);
  const original = content;

  for (let index = 0; index < argumentNames.length; index += 1) {
    const name = argumentNames[index];
    if (!name) continue;
    content = content.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "g"), () => parsed[index] ?? "");
  }
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, digits: string) => parsed[Number(digits)] ?? "");
  content = content.replace(/\$(\d+)(?!\w)/g, (_, digits: string) => parsed[Number(digits) - 1] ?? "");
  content = content.replaceAll("$ARGUMENTS", args);

  if (content === original && appendIfNoPlaceholder && args) {
    content = `${content}\n\nARGUMENTS: ${args}`;
  }
  return content;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Embedded shell substitution                                         */
/* ------------------------------------------------------------------ */

const SHELL_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const SHELL_INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

interface AuthoredShellPattern {
  /** Complete matched text, including the ```` ```! ```` fence or `` !` ` `` delimiters. */
  raw: string;
  /** Command text only. */
  command: string;
}

/** Shell substitutions authored in a skill body, in the order they appear. */
export function shellPatterns(text: string): AuthoredShellPattern[] {
  const blocks = text.matchAll(SHELL_BLOCK_PATTERN);
  const inlines = text.includes("!`") ? text.matchAll(SHELL_INLINE_PATTERN) : [];
  return [...blocks, ...inlines].flatMap((match) => {
    const command = match[1]?.trim();
    return command ? [{ raw: match[0], command }] : [];
  });
}

export async function expandShellSubstitutions(
  text: string,
  shell: "bash" | "powershell" | undefined,
  options: SkillExpansionOptions,
): Promise<string> {
  const selected = shell ?? "bash";
  const patterns = shellPatterns(text);
  const outputs = await Promise.all(patterns.map((pattern) => runSkillShell(pattern.command, selected, options)));
  return replacePatterns(text, patterns.map((pattern) => pattern.raw), outputs);
}

/**
 * Splices command outputs into `text` at the authored pattern positions. Scanning
 * left to right keeps one command's output from being mistaken for another
 * command's placeholder.
 */
function replacePatterns(text: string, raws: readonly string[], outputs: readonly string[]): string {
  const patterns = raws
    .map((raw, index) => ({ raw, output: outputs[index] ?? "" }))
    .filter((pattern) => pattern.raw.length > 0)
    .sort((left, right) => right.raw.length - left.raw.length);
  if (patterns.length === 0) return text;

  let result = "";
  let index = 0;
  while (index < text.length) {
    const match = patterns.find((pattern) => text.startsWith(pattern.raw, index));
    if (match) {
      result += match.output;
      index += match.raw.length;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

/** Runs one embedded skill command and caps its output for prompt injection. */
async function runSkillShell(
  command: string,
  shell: "bash" | "powershell",
  options: SkillExpansionOptions,
): Promise<string> {
  const output = await (options.runCommand
    ? options.runCommand(command, shell)
    : shell === "powershell"
      ? runPowerShell(command, options)
      : runBash(command, options));
  return limitShellOutput(shellOutput(output));
}

async function runBash(command: string, options: SkillExpansionOptions): Promise<string> {
  const result = await new BashExecutor().run(
    { command, workingDirectory: options.cwd, timeoutMs: DEFAULT_BASH_TIMEOUT_MS },
    [options.cwd],
    options.signal,
    { onRunning: () => undefined, onOutput: () => undefined },
  );
  if (result.status === "timed_out") {
    throw new Error(`Shell command timed out after ${DEFAULT_BASH_TIMEOUT_MS} ms: ${command}`);
  }
  if (result.status !== "complete") {
    throw new Error(`Shell command failed: ${result.output || `exit ${result.exitCode ?? "unknown"}`}`);
  }
  return shellOutput(result.output);
}

/** BashExecutor reports successful silent commands as "(no output)". */
function shellOutput(output: string): string {
  const text = output.trimEnd();
  return text === "(no output)" ? "" : text;
}

async function runPowerShell(command: string, options: SkillExpansionOptions): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: options.cwd,
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error("pwsh is not installed") : error);
    });
    child.on("close", (exitCode) => {
      const text = [stdout.join(""), stderr.join("") ? `[stderr] ${stderr.join("")}` : ""]
        .filter(Boolean).join("\n").trim();
      if (exitCode === 0) resolve(text);
      else reject(new Error(`Shell command failed with exit ${exitCode}: ${text || "(no output)"}`));
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Shell command timed out after ${DEFAULT_BASH_TIMEOUT_MS} ms: ${command}`));
    }, DEFAULT_BASH_TIMEOUT_MS);
    child.on("close", () => clearTimeout(timeout));
  });
  return output;
}

function limitShellOutput(output: string): string {
  if (output.length <= MAX_SHELL_OUTPUT_CHARACTERS) return output;
  return `${output.slice(0, MAX_SHELL_OUTPUT_CHARACTERS)}\n[output truncated]`;
}

/* ------------------------------------------------------------------ */
/* Skill listing reminder                                              */
/* ------------------------------------------------------------------ */

const EMPTY_SKILL_LISTING = "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n</system-reminder>\n";

/**
 * Renders the skill listing block injected into conversation context. Preserves
 * the exact empty form when no skills are available.
 */
export function renderSkillReminder(
  skills: readonly SkillDefinition[],
  contextTokens?: number,
): string {
  if (skills.length === 0) return EMPTY_SKILL_LISTING;
  const listing = formatSkillsWithinBudget(skills, contextTokens);
  return `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${listing}\n</system-reminder>\n`;
}

function skillCharacterBudget(contextTokens?: number): number {
  const override = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
  if (override) return override;
  if (contextTokens) return Math.floor(contextTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT);
  return DEFAULT_CHAR_BUDGET;
}

function skillDescription(skill: SkillDefinition): string {
  const description = skill.whenToUse ? `${skill.description} - ${skill.whenToUse}` : skill.description;
  return description.length > MAX_LISTING_DESC_CHARS
    ? `${description.slice(0, MAX_LISTING_DESC_CHARS - 1)}…`
    : description;
}

function formatSkillsWithinBudget(skills: readonly SkillDefinition[], contextTokens?: number): string {
  const budget = skillCharacterBudget(contextTokens);
  const entries = skills.map((skill) => `- ${skill.name}: ${skillDescription(skill)}`);
  const total = entries.reduce((sum, entry) => sum + stringWidth(entry), 0) + (entries.length - 1);
  if (total <= budget) return entries.join("\n");

  const nameOverhead = skills.reduce((sum, skill) => sum + stringWidth(skill.name) + 4, 0) + (skills.length - 1);
  const maxDescriptionLength = Math.floor((budget - nameOverhead) / skills.length);
  if (maxDescriptionLength < MIN_DESC_LENGTH) {
    return skills.map((skill) => `- ${skill.name}`).join("\n");
  }
  return skills
    .map((skill) => `- ${skill.name}: ${truncateToWidth(skillDescription(skill), maxDescriptionLength)}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Display width                                                       */
/* ------------------------------------------------------------------ */

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** CJK-aware display width: wide characters count as two columns. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    width += WIDE_RANGES.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
  }
  return width;
}

/** Truncates to a display width, appending an ellipsis when content is removed. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let width = 0;
  let result = "";
  for (const character of text) {
    const characterWidth = stringWidth(character);
    if (width + characterWidth > maxWidth - 1) break;
    width += characterWidth;
    result += character;
  }
  return `${result}…`;
}

/* ------------------------------------------------------------------ */
/* Compaction reinjection                                              */
/* ------------------------------------------------------------------ */

/**
 * Skill content that must be restored after compaction removed the messages it
 * was injected in. Skills still present in the active history are skipped so
 * instructions are never duplicated.
 */
export function compactedSkillInstructions(
  invoked: readonly { name: string; content: string }[],
  activeSkillNames: ReadonlySet<string>,
): string[] {
  return invoked
    .filter((skill) => !activeSkillNames.has(skill.name))
    .map((skill) => (skill.content.length > MAX_REINJECTED_SKILL_CHARACTERS
      ? `${skill.content.slice(0, MAX_REINJECTED_SKILL_CHARACTERS)}\n[skill instructions truncated]`
      : skill.content));
}
