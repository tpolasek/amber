import { BUILT_IN_COMMANDS } from "../built-in-commands.js";
import { THINKING_LEVELS } from "../thinking-level.js";

/** Everything Tab completion needs beyond the built-in command list. */
export interface CompletionSources {
  models: Array<{ key: string; model: string }>;
  /** Short session prefixes, as `/list` prints them. */
  sessions: string[];
  /** Skill names without the leading slash. */
  skills: string[];
}

export const LOCAL_COMMANDS: readonly string[] = [
  "/effort",
  "/history",
  "/list",
  "/model",
  "/new",
  "/output",
  "/quit",
  "/switch",
  "/usage",
];

/** Full-line completions for `line`, matching readline's completer contract. */
export function completionsFor(line: string, sources: CompletionSources): string[] {
  if (!line.startsWith("/")) return [];
  const space = line.search(/\s/);
  if (space === -1) return commandCompletions(line, sources);
  const command = line.slice(0, space);
  const argument = line.slice(space + 1);
  if (/\s/.test(argument)) return [];
  switch (command) {
    case "/model":
      // Models match by full key or bare id, but always complete to the key.
      return [...new Set(sources.models
        .filter((model) => model.key.startsWith(argument) || model.model.startsWith(argument))
        .map((model) => model.key))].sort().map((key) => `${command} ${key}`);
    case "/effort":
      return argumentCompletions(command, THINKING_LEVELS, argument);
    case "/switch":
      return argumentCompletions(command, sources.sessions, argument);
    default:
      return [];
  }
}

function commandCompletions(prefix: string, sources: CompletionSources): string[] {
  const names = new Set<string>(LOCAL_COMMANDS);
  for (const command of BUILT_IN_COMMANDS) names.add(command.name);
  for (const skill of sources.skills) names.add(`/${skill}`);
  return [...names].filter((name) => name.startsWith(prefix)).sort();
}

function argumentCompletions(command: string, candidates: readonly string[], argument: string): string[] {
  const matches = new Set(candidates.filter((candidate) => candidate.startsWith(argument)));
  return [...matches].sort().map((candidate) => `${command} ${candidate}`);
}

export interface CompletionApi {
  listSessions(): Promise<Array<{ id: string }>>;
  modelCatalog(): Promise<{ models: Array<{ key: string; model: string }> }>;
  skills(sessionId: string): Promise<string[]>;
}

const DEFAULT_REFRESH_MS = 5_000;
const MODEL_REFRESH_MS = 60_000;

/** Keeps the completion sources warm so a Tab press rarely waits on the server. */
export class CompletionCache {
  private sources: CompletionSources = { models: [], sessions: [], skills: [] };
  private fetchedAt: Record<keyof CompletionSources, number> = {
    models: Number.NEGATIVE_INFINITY,
    sessions: Number.NEGATIVE_INFINITY,
    skills: Number.NEGATIVE_INFINITY,
  };

  constructor(
    private readonly api: CompletionApi,
    private readonly sessionId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async completions(line: string): Promise<string[]> {
    await this.refresh();
    return completionsFor(line, this.sources);
  }

  /** Session-scoped skills changed (a different session is attached). */
  invalidateSkills(): void {
    this.fetchedAt.skills = Number.NEGATIVE_INFINITY;
  }

  private async refresh(): Promise<void> {
    const at = this.now();
    const sessionId = this.sessionId();
    const loads: Array<Promise<void>> = [];
    if (at - this.fetchedAt.sessions >= DEFAULT_REFRESH_MS) {
      loads.push(this.reload("sessions", async () =>
        (await this.api.listSessions()).map((session) => session.id.slice(0, 8))));
    }
    if (at - this.fetchedAt.models >= MODEL_REFRESH_MS) {
      loads.push(this.reload("models", async () => (await this.api.modelCatalog()).models));
    }
    if (at - this.fetchedAt.skills >= DEFAULT_REFRESH_MS) {
      loads.push(this.reload("skills", async () => await this.api.skills(sessionId)));
    }
    await Promise.all(loads);
  }

  private async reload<K extends keyof CompletionSources>(
    key: K,
    load: () => Promise<CompletionSources[K]>,
  ): Promise<void> {
    // Stamp first so concurrent Tab presses share one fetch; failures retry next time.
    this.fetchedAt[key] = this.now();
    try {
      const loaded = await load();
      this.sources = { ...this.sources, [key]: loaded };
    } catch {
      this.fetchedAt[key] = Number.NEGATIVE_INFINITY;
    }
  }
}
