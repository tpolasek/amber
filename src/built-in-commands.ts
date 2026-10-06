export interface BuiltInCommand {
  name: string;
  description: string;
  runsDuringResponse: boolean;
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { name: "/add-dir", description: "Add a working directory for this session", runsDuringResponse: true },
  { name: "/btw", description: "Ask a side question about this session; the answer stays out of the conversation", runsDuringResponse: true },
  { name: "/cwd", description: "Show or change the current working directory", runsDuringResponse: false },
  { name: "/usage", description: "Show context and total session token usage", runsDuringResponse: true },
  { name: "/clear", description: "Erase this session's conversation and model context", runsDuringResponse: false },
  { name: "/compact", description: "Summarize model context while keeping the full transcript; on/off toggles auto-compaction", runsDuringResponse: false },
  { name: "/fork", description: "Fork this session with its complete history", runsDuringResponse: false },
  { name: "/git", description: "Inspect the repository: diff, show, status; commit [push]", runsDuringResponse: false },
  { name: "/goal", description: "Set a goal the model keeps working toward, or clear it", runsDuringResponse: true },
  { name: "/name", description: "Generate a session name, or pass a title", runsDuringResponse: false },
  { name: "/plugin", description: "Manage plugin marketplaces, and install, enable, update, or remove plugins", runsDuringResponse: false },
  { name: "/search", description: "Find text in this session's conversation", runsDuringResponse: true },
  { name: "/tasks", description: "List and manage background shell tasks", runsDuringResponse: true },
];

export function builtInCommand(input: string): BuiltInCommand | undefined {
  const trimmed = input.trim();
  const name = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
  if (name === "/bashes") return BUILT_IN_COMMANDS.find((command) => command.name === "/tasks");
  const command = BUILT_IN_COMMANDS.find((candidate) => candidate.name === name);
  if (!command) return undefined;
  // /compact on|off only flips the per-session auto-compaction flag, so it is safe mid-response.
  if (command.name === "/compact" && /^\/compact\s+(on|off)$/i.test(trimmed)) {
    return { ...command, runsDuringResponse: true };
  }
  return command;
}
