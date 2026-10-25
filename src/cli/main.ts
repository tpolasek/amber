export interface CliArgs {
  server: string;
  history: number;
  list: boolean;
  session?: string;
  newName?: string;
}

export type ParsedCliArgs = { kind: "args"; args: CliArgs } | { kind: "help" };

export function cliUsageText(): string {
  return [
    "AMBER cli - terminal client for amber sessions.",
    "",
    "Usage: amber cli [options] [session-id-prefix]",
    "",
    "Options:",
    "  --server <url>   Amber server base url (default $AMBER_SERVER or http://127.0.0.1:3000).",
    "  --new [name]     Create a session rooted at the current directory.",
    "  --list           List sessions and exit.",
    "  --history <n>    Turns printed on attach (default 2).",
    "  -h, --help       Show this help and exit.",
    "",
    "Local commands: /output [chars] /history [n] /list /new [name] /quit.",
    "Other slash commands go to the server. Ctrl-C aborts a running response;",
    "pressed twice it exits.",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  const args: CliArgs = {
    server: env.AMBER_SERVER && env.AMBER_SERVER !== "" ? env.AMBER_SERVER : "http://127.0.0.1:3000",
    history: 2,
    list: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--server") {
      const value = argv[i + 1];
      if (!value) throw new Error("--server requires a url");
      args.server = value;
      i += 1;
    } else if (argument === "--history") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) throw new Error("--history requires a non-negative integer");
      args.history = value;
      i += 1;
    } else if (argument === "--list") {
      args.list = true;
    } else if (argument === "--new") {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) args.newName = value;
      else args.newName = "";
      if (args.newName !== "") i += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 1) throw new Error("only one session id may be given");
  if (positional.length === 1) args.session = positional[0]!;
  return { kind: "args", args };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    if (parseCliArgs(argv).kind === "help") {
      process.stdout.write(`${cliUsageText()}\n`);
      return 0;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`amber cli: ${error instanceof Error ? error.message : String(error)}\n\n${cliUsageText()}\n`);
    return 2;
  }
}
