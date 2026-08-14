import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { AgentDefinition } from "./agent-tool.js";

export interface AmberSettings {
  auth_key?: string;
  auth_url?: string;
  default_model?: string;
  agents: AgentDefinition[];
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
  auth_key: "<INSERT_AUTH_KEY_HERE>",
  auth_url: "<INSERT_AUTH_URL_HERE>",
  default_model: "<INSERT_DEFAULT_MODEL_HERE>",
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

export async function loadSettings(homeDirectory = homedir()): Promise<AmberSettings> {
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.toml");
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });

  let source: string;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const initialSource = stringify(SETTINGS_TEMPLATE);
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
  for (const key of ["auth_key", "auth_url", "default_model"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      throw new Error(`${settingsPath}: ${key} must be a string`);
    }
  }
  return {
    ...(typeof settings.auth_key === "string" ? { auth_key: settings.auth_key } : {}),
    ...(typeof settings.auth_url === "string" ? { auth_url: settings.auth_url } : {}),
    ...(typeof settings.default_model === "string" ? { default_model: settings.default_model } : {}),
    agents: parseAgentDefinitions(settings.agents, settingsPath),
  };
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
    return {
      type: (agent.type as string).trim(),
      whenToUse: (agent.whenToUse as string).trim(),
      systemPrompt: agent.systemPrompt as string,
      readOnly: agent.readOnly,
    };
  });
  const types = definitions.map((agent) => agent.type);
  if (new Set(types).size !== types.length) {
    throw new Error(`${settingsPath}: agent types must be unique`);
  }
  return definitions;
}
