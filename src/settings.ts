import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { AgentDefinition } from "./agent-tool.js";
import type { ProviderProtocol, ThinkingLevel } from "./types.js";
import { COMMIT_SKILL_TEMPLATE_SOURCE, SETTINGS_TEMPLATE_SOURCE } from "./settings-template.js";

export interface AmberSettings {
  theme?: AmberTheme;
  default_provider?: string;
  default_agent_provider?: string;
  default_agent_model?: string;
  providers: Record<string, ProviderSettings>;
  agents: AgentDefinition[];
}

export type AmberTheme = "dark" | "light" | "light+" | "hacker";

export interface ModelSettings {
  thinking_level?: ThinkingLevel;
  compact_tokens?: number;
}

export interface ProviderSettings extends ModelSettings {
  api: ProviderProtocol;
  auth?: "openai-codex";
  auth_key?: string;
  auth_url: string;
  default_model?: string;
  models: Record<string, ModelSettings>;
}

export interface EditableProviderSettings extends ModelSettings {
  api: ProviderProtocol;
  auth?: "openai-codex";
  auth_key?: string;
  auth_url?: string;
  default_model?: string;
  models: Record<string, ModelSettings>;
}

export interface EditableAmberSettings {
  theme: AmberTheme;
  default_provider?: string;
  default_agent_provider?: string;
  default_agent_model?: string;
  providers: Record<string, EditableProviderSettings>;
  agents: AgentDefinition[];
}

export async function loadSettings(homeDirectory = homedir()): Promise<AmberSettings> {
  const { source, path } = await loadSettingsSource(homeDirectory);
  return parseSettingsSource(source, path);
}

export async function loadSettingsSource(homeDirectory = homedir()): Promise<{ source: string; path: string }> {
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });

  let source: string;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const initialSource = SETTINGS_TEMPLATE_SOURCE;
    try {
      await writeFile(settingsPath, initialSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (!isAlreadyExistsError(writeError)) throw writeError;
    }
    await seedCommitSkill(settingsDirectory);
    source = await readFile(settingsPath, "utf8");
  }

  return { source, path: settingsPath };
}

export function parseSettingsSource(source: string, settingsPath = join(homedir(), ".amber", "settings.toml")): AmberSettings {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Could not read ${settingsPath}: ${errorMessage(error)}`);
  }
  return parseSettings(parsed, settingsPath);
}

export async function saveSettingsSource(source: string, homeDirectory = homedir()): Promise<string> {
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  const temporaryPath = join(settingsDirectory, `.settings-${randomUUID()}.tmp`);
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, settingsPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return settingsPath;
}

/** Converts parsed settings into the canonical shape exposed to the settings UI. */
export function settingsForEditor(settings: AmberSettings): EditableAmberSettings {
  return {
    theme: settings.theme ?? "light+",
    ...(settings.default_provider ? { default_provider: settings.default_provider } : {}),
    ...(settings.default_agent_provider ? { default_agent_provider: settings.default_agent_provider } : {}),
    ...(settings.default_agent_model ? { default_agent_model: settings.default_agent_model } : {}),
    providers: Object.fromEntries(Object.entries(settings.providers).map(([name, provider]) => {
      const authKey = configuredSetting(provider.auth_key);
      const authUrl = configuredSetting(provider.auth_url);
      const defaultModel = configuredSetting(provider.default_model);
      return [name, {
        api: provider.api,
        ...(provider.auth ? { auth: provider.auth } : {}),
        ...(authKey ? { auth_key: authKey } : {}),
        ...(authUrl && !(provider.auth === "openai-codex" && authUrl === "https://chatgpt.com/backend-api")
          ? { auth_url: authUrl }
          : {}),
        ...(defaultModel ? { default_model: defaultModel } : {}),
        ...(provider.thinking_level ? { thinking_level: provider.thinking_level } : {}),
        ...(provider.compact_tokens ? { compact_tokens: provider.compact_tokens } : {}),
        models: structuredClone(provider.models),
      } satisfies EditableProviderSettings];
    })),
    agents: structuredClone(settings.agents),
  };
}

/** Encodes the UI's structured document and validates it with the normal settings parser. */
export function settingsSourceFromEditor(
  value: unknown,
  settingsPath = join(homedir(), ".amber", "settings.toml"),
): { source: string; settings: AmberSettings } {
  let source: string;
  try {
    source = `${stringify(canonicalEditorValue(value)).trimEnd()}\n`;
  } catch (error) {
    throw new Error(`Could not write ${settingsPath}: ${errorMessage(error)}`);
  }
  return { source, settings: parseSettingsSource(source, settingsPath) };
}

function canonicalEditorValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  copySetting(result, value, "theme");
  copyOptionalString(result, value, "default_provider");
  copyOptionalString(result, value, "default_agent_provider");
  copyOptionalString(result, value, "default_agent_model");
  result.providers = canonicalProviders(value.providers);
  result.agents = canonicalAgents(value.agents);
  return result;
}

function canonicalProviders(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, candidate]) => {
    if (!isRecord(candidate)) return [name, candidate];
    const provider: Record<string, unknown> = {};
    copySetting(provider, candidate, "api");
    copySetting(provider, candidate, "auth");
    copySetting(provider, candidate, "auth_key");
    if (!(candidate.auth === "openai-codex"
      && (candidate.auth_url === undefined || candidate.auth_url === "https://chatgpt.com/backend-api"))) {
      copySetting(provider, candidate, "auth_url");
    }
    copyOptionalString(provider, candidate, "default_model");
    copyOptionalString(provider, candidate, "thinking_level");
    copySetting(provider, candidate, "compact_tokens");
    const models = canonicalModels(candidate.models);
    if (!isRecord(models) || Object.keys(models).length > 0) provider.models = models;
    return [name, provider];
  }));
}

function canonicalModels(value: unknown): unknown {
  if (value === undefined) return {};
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, candidate]) => {
    if (!isRecord(candidate)) return [name, candidate];
    const model: Record<string, unknown> = {};
    copyOptionalString(model, candidate, "thinking_level");
    copySetting(model, candidate, "compact_tokens");
    return [name, model];
  }));
}

function canonicalAgents(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    const agent: Record<string, unknown> = {};
    copySetting(agent, candidate, "type");
    copySetting(agent, candidate, "whenToUse");
    copySetting(agent, candidate, "systemPrompt");
    copySetting(agent, candidate, "readOnly");
    copySetting(agent, candidate, "compact");
    copyOptionalString(agent, candidate, "model");
    return agent;
  });
}

function copySetting(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) target[key] = source[key];
}

function copyOptionalString(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "string" && !source[key].trim()) return;
  copySetting(target, source, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSettings(parsed: unknown, settingsPath: string): AmberSettings {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a TOML table`);
  }

  const settings = parsed as Record<string, unknown>;
  const theme = parseTheme(settings.theme, `${settingsPath}: theme`);
  if (settings.default_provider !== undefined
    && (typeof settings.default_provider !== "string" || !settings.default_provider.trim())) {
    throw new Error(`${settingsPath}: default_provider must be a non-empty string`);
  }
  const providers = settings.providers === undefined
    ? parseLegacyProvider(settings, settingsPath)
    : parseProviders(settings.providers, settingsPath);
  const defaultProvider = typeof settings.default_provider === "string" ? settings.default_provider.trim() : undefined;
  if (defaultProvider && !providers[defaultProvider]) {
    throw new Error(`${settingsPath}: default_provider '${defaultProvider}' is not configured`);
  }
  const defaultAgentProvider = optionalString(settings.default_agent_provider, `${settingsPath}: default_agent_provider`);
  const defaultAgentModel = optionalString(settings.default_agent_model, `${settingsPath}: default_agent_model`);
  if (defaultAgentProvider && !providers[defaultAgentProvider]) {
    throw new Error(`${settingsPath}: default_agent_provider '${defaultAgentProvider}' is not configured`);
  }
  if (defaultAgentModel && !defaultAgentProvider) {
    throw new Error(`${settingsPath}: default_agent_model requires default_agent_provider`);
  }
  return {
    theme,
    ...(defaultProvider ? { default_provider: defaultProvider } : {}),
    ...(defaultAgentProvider ? { default_agent_provider: defaultAgentProvider } : {}),
    ...(defaultAgentModel ? { default_agent_model: defaultAgentModel } : {}),
    providers,
    agents: parseAgentDefinitions(settings.agents, settingsPath),
  };
}

function parseTheme(value: unknown, field: string): AmberTheme {
  if (value === undefined || value === "light+") return "light+";
  if (value === "dark" || value === "light" || value === "hacker") return value;
  throw new Error(`${field} must be dark, light, light+, or hacker`);
}

function parseProviders(value: unknown, settingsPath: string): Record<string, ProviderSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${settingsPath}: providers must be a table`);
  }
  const providers: Record<string, ProviderSettings> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!name.trim() || name.includes("/")) {
      throw new Error(`${settingsPath}: provider names must be non-empty and cannot contain '/'`);
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${settingsPath}: providers.${name} must be a table`);
    }
    const provider = candidate as Record<string, unknown>;
    const api = parseProviderProtocol(provider.api, `${settingsPath}: providers.${name}.api`);
    const auth = parseProviderAuth(provider.auth, `${settingsPath}: providers.${name}.auth`);
    if (auth === "openai-codex" && api !== "openai") {
      throw new Error(`${settingsPath}: providers.${name}: openai-codex auth requires api = "openai"`);
    }
    if (auth === "openai-codex" && provider.auth_key !== undefined) {
      throw new Error(`${settingsPath}: providers.${name}: use auth or auth_key, not both`);
    }
    const authKey = auth === "openai-codex"
      ? undefined
      : requiredString(provider.auth_key, `${settingsPath}: providers.${name}.auth_key`);
    const authUrl = optionalString(provider.auth_url, `${settingsPath}: providers.${name}.auth_url`)
      ?? (auth === "openai-codex" ? "https://chatgpt.com/backend-api" : undefined);
    if (!authUrl) throw new Error(`${settingsPath}: providers.${name}.auth_url must be a non-empty string`);
    const defaultModel = optionalString(provider.default_model, `${settingsPath}: providers.${name}.default_model`);
    const models = parseModels(provider.models, `${settingsPath}: providers.${name}.models`, api);
    if (auth === "openai-codex" && !defaultModel && Object.keys(models).length === 0) {
      throw new Error(`${settingsPath}: providers.${name}: openai-codex auth requires default_model or at least one explicit model`);
    }
    providers[name] = {
      api,
      ...(auth ? { auth } : {}),
      ...(authKey ? { auth_key: authKey } : {}),
      auth_url: authUrl,
      ...(defaultModel ? { default_model: defaultModel } : {}),
      ...parseModelSettings(provider, `${settingsPath}: providers.${name}`),
      models,
    };
  }
  if (Object.keys(providers).length === 0) throw new Error(`${settingsPath}: configure at least one provider`);
  return providers;
}

function parseModels(value: unknown, field: string, api: ProviderProtocol): Record<string, ModelSettings> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a table`);
  const models: Record<string, ModelSettings> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!name.trim()) throw new Error(`${field} model names cannot be empty`);
    if (api === "anthropic" && name.includes("/")) {
      throw new Error(`${field} model names cannot contain '/'`);
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${field}.${name} must be a table`);
    }
    models[name] = parseModelSettings(candidate as Record<string, unknown>, `${field}.${name}`);
  }
  return models;
}

function parseModelSettings(value: Record<string, unknown>, field: string): ModelSettings {
  const thinkingLevel = value.thinking_level;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    throw new Error(`${field}.thinking_level must be none, low, medium, high, xhigh, or max`);
  }
  const compactTokens = value.compact_tokens;
  if (compactTokens !== undefined
    && (!Number.isSafeInteger(compactTokens) || (compactTokens as number) <= 0)) {
    throw new Error(`${field}.compact_tokens must be a positive integer`);
  }
  return {
    ...(isThinkingLevel(thinkingLevel) ? { thinking_level: thinkingLevel } : {}),
    ...(typeof compactTokens === "number" ? { compact_tokens: compactTokens } : {}),
  };
}

function parseLegacyProvider(settings: Record<string, unknown>, settingsPath: string): Record<string, ProviderSettings> {
  for (const key of ["auth_key", "auth_url", "default_model"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      throw new Error(`${settingsPath}: ${key} must be a string`);
    }
  }
  const authKey = typeof settings.auth_key === "string" ? settings.auth_key : "";
  const authUrl = typeof settings.auth_url === "string" ? settings.auth_url : "https://api.anthropic.com";
  const defaultModel = typeof settings.default_model === "string" ? settings.default_model : undefined;
  if (!authKey && !defaultModel) return {};
  return {
    default: {
      api: "anthropic",
      auth_key: authKey,
      auth_url: authUrl,
      ...(defaultModel ? { default_model: defaultModel, models: { [defaultModel]: {} } } : { models: {} }),
    },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "none" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max";
}

function parseProviderProtocol(value: unknown, field: string): ProviderProtocol {
  if (value === undefined || value === "anthropic") return "anthropic";
  if (value === "openai") return "openai";
  throw new Error(`${field} must be anthropic or openai`);
}

function parseProviderAuth(value: unknown, field: string): "openai-codex" | undefined {
  if (value === undefined) return undefined;
  if (value === "openai-codex") return value;
  throw new Error(`${field} must be openai-codex when set`);
}

export function configuredSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("<INSERT_") && trimmed.endsWith("_HERE>")) return undefined;
  return trimmed;
}

/** Seeds the default user-level commit skill next to freshly created settings. */
async function seedCommitSkill(settingsDirectory: string): Promise<void> {
  const skillDirectory = join(settingsDirectory, "skills", "commit");
  await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(skillDirectory, "SKILL.md"), COMMIT_SKILL_TEMPLATE_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAgentDefinitions(value: unknown, settingsPath: string): AgentDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${settingsPath}: agents must be an array`);
  const definitions = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${settingsPath}: agents[${index}] must be an object`);
    }
    const agent = candidate as Record<string, unknown>;
    for (const key of ["type", "whenToUse", "systemPrompt"] as const) {
      if (typeof agent[key] !== "string" || !agent[key].trim()) {
        throw new Error(`${settingsPath}: agents[${index}].${key} must be a non-empty string`);
      }
    }
    if (typeof agent.readOnly !== "boolean") {
      throw new Error(`${settingsPath}: agents[${index}].readOnly must be a boolean`);
    }
    if (agent.compact !== undefined && typeof agent.compact !== "boolean") {
      throw new Error(`${settingsPath}: agents[${index}].compact must be a boolean`);
    }
    if (agent.auth_key !== undefined || agent.auth_url !== undefined) {
      throw new Error(`${settingsPath}: agents[${index}] must use model = "provider/model" instead of auth_key or auth_url`);
    }
    if (agent.model !== undefined
      && (typeof agent.model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(agent.model.trim()))) {
      throw new Error(`${settingsPath}: agents[${index}].model must use provider/model`);
    }
    return {
      type: (agent.type as string).trim(),
      whenToUse: (agent.whenToUse as string).trim(),
      systemPrompt: agent.systemPrompt as string,
      readOnly: agent.readOnly,
      ...(typeof agent.compact === "boolean" ? { compact: agent.compact } : {}),
      ...(typeof agent.model === "string" ? { model: agent.model.trim() } : {}),
    };
  });
  const types = definitions.map((agent) => agent.type);
  if (new Set(types).size !== types.length) {
    throw new Error(`${settingsPath}: agent types must be unique`);
  }
  return definitions;
}
