export interface BuiltInCommand {
  name: string;
  description: string;
  runsDuringResponse: boolean;
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { name: "/add-dir", description: "Add a working directory for this session", runsDuringResponse: true },
  { name: "/cwd", description: "Show or change the current working directory", runsDuringResponse: false },
  { name: "/context", description: "Show token usage for the current model context", runsDuringResponse: true },
  { name: "/clear", description: "Erase this session's conversation and model context", runsDuringResponse: false },
  { name: "/commit", description: "Commit current changes with a generated message; add 'push' to also push", runsDuringResponse: false },
  { name: "/compact", description: "Summarize model context while keeping the full transcript", runsDuringResponse: false },
  { name: "/fork", description: "Fork this session with its complete history", runsDuringResponse: false },
  { name: "/git", description: "Inspect the repository: diff, show, status; commit [push]", runsDuringResponse: false },
  { name: "/name", description: "Generate a session name, or pass a title", runsDuringResponse: false },
  { name: "/tasks", description: "List and manage background tasks", runsDuringResponse: false },
];

export function builtInCommand(input: string): BuiltInCommand | undefined {
  const name = input.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (name === "/bashes") return BUILT_IN_COMMANDS.find((command) => command.name === "/tasks");
  return BUILT_IN_COMMANDS.find((command) => command.name === name);
}
