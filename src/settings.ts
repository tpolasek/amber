import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { AgentDefinition } from "./agent-tool.js";

export interface AmberSettings {
  default_provider?: string;
  providers: Record<string, ProviderSettings>;
  agents: AgentDefinition[];
}

export type ThinkingLevel = "low" | "medium" | "high" | "max";

export interface ModelSettings {
  thinking_level?: ThinkingLevel;
  compact_tokens?: number;
}

export interface ProviderSettings extends ModelSettings {
  auth_key: string;
  auth_url: string;
  default_model?: string;
  models: Record<string, ModelSettings>;
}

const SHARED_AGENT_PREFIX = "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.";

const SHARED_AGENT_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

export const SETTINGS_TEMPLATE = {
  default_provider: "default",
  providers: {
    default: {
      auth_key: "<INSERT_AUTH_KEY_HERE>",
      auth_url: "<INSERT_AUTH_URL_HERE>",
      default_model: "<INSERT_DEFAULT_MODEL_HERE>",
      thinking_level: "max",
      compact_tokens: 100_000,
      models: {},
    },
  },
  agents: [
    {
      type: "general-purpose",
      whenToUse: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
      systemPrompt: `${SHARED_AGENT_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_AGENT_GUIDELINES}`,
      readOnly: false,
    },
    {
      type: "code-review",
      whenToUse: "Review the most recent working-tree change for concrete logic bugs and errors. Use after code changes when a focused correctness review is needed.",
      systemPrompt: `${SHARED_AGENT_PREFIX}

You are a code-review agent. Your sole job is to review the repository's most recent change as shown by git diff and report concrete logic bugs or errors.

Rules:
- Start from git diff. Include staged changes if necessary to understand the complete current change.
- Inspect surrounding code only when needed to verify whether a changed line is actually wrong.
- Report only actionable correctness problems: logic bugs, runtime errors, broken edge cases, regressions, or security errors.
- Do not report style, naming, formatting, documentation, test-coverage, or subjective design feedback.
- Do not edit files or otherwise change the repository.
- For each finding, identify the file and line, explain the failure mode, and state when it occurs.
- If there are no logic bugs or errors, say exactly: No logic bugs or errors found.
- Return only the findings (or the no-findings sentence), with no praise, summary, or preamble.`,
      readOnly: true,
    },
  ],
} as const;

export const SETTINGS_TEMPLATE_SOURCE = `${stringify(SETTINGS_TEMPLATE).trimEnd()}
# model = "<INSERT_AGENT_MODEL_HERE>"
`;

export async function loadSettings(homeDirectory = homedir()): Promise<AmberSettings> {
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
    source = await readFile(settingsPath, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Could not read ${settingsPath}: ${errorMessage(error)}`);
  }
  return parseSettings(parsed, settingsPath);
}

function parseSettings(parsed: unknown, settingsPath: string): AmberSettings {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a TOML table`);
  }

  const settings = parsed as Record<string, unknown>;
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
  return {
    ...(defaultProvider ? { default_provider: defaultProvider } : {}),
    providers,
    agents: parseAgentDefinitions(settings.agents, settingsPath),
  };
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
    const authKey = requiredString(provider.auth_key, `${settingsPath}: providers.${name}.auth_key`);
    const authUrl = requiredString(provider.auth_url, `${settingsPath}: providers.${name}.auth_url`);
    const defaultModel = optionalString(provider.default_model, `${settingsPath}: providers.${name}.default_model`);
    providers[name] = {
      auth_key: authKey,
      auth_url: authUrl,
      ...(defaultModel ? { default_model: defaultModel } : {}),
      ...parseModelSettings(provider, `${settingsPath}: providers.${name}`),
      models: parseModels(provider.models, `${settingsPath}: providers.${name}.models`),
    };
  }
  if (Object.keys(providers).length === 0) throw new Error(`${settingsPath}: configure at least one provider`);
  return providers;
}

function parseModels(value: unknown, field: string): Record<string, ModelSettings> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a table`);
  const models: Record<string, ModelSettings> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!name.trim() || name.includes("/")) throw new Error(`${field} model names cannot be empty or contain '/'`);
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
    throw new Error(`${field}.thinking_level must be low, medium, high, or max`);
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
  return value === "low" || value === "medium" || value === "high" || value === "max";
}

export function configuredSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("<INSERT_") && trimmed.endsWith("_HERE>")) return undefined;
  return trimmed;
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
      ...(typeof agent.model === "string" ? { model: agent.model.trim() } : {}),
    };
  });
  const types = definitions.map((agent) => agent.type);
  if (new Set(types).size !== types.length) {
    throw new Error(`${settingsPath}: agent types must be unique`);
  }
  return definitions;
}
