export type CliCommand =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; argument: string };

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

export function parseCliCommand(argv: readonly string[]): CliCommand {
  if (argv.some((argument) => HELP_FLAGS.has(argument))) return { kind: "help" };
  if (argv.some((argument) => VERSION_FLAGS.has(argument))) return { kind: "version" };
  const unknown = argv.find((argument) => argument.length > 0);
  if (unknown) return { kind: "unknown", argument: unknown };
  return { kind: "start" };
}

export function usageText(): string {
  return [
    "AMBER - a browser-based interface for local LLM coding sessions.",
    "",
    "Usage: amber [options]",
    "",
    "Running amber with no options starts the server and opens it in a browser.",
    "",
    "Options:",
    "  -h, --help     Show this help and exit.",
    "  -v, --version  Show the build version and exit.",
    "",
    "Environment variables:",
    "  PORT           Port to listen on (default 3000).",
    "  HOST           Address to bind to (default 127.0.0.1).",
    "  DATA_DIR       Session storage directory (default ~/.amber/data/sessions).",
    "  AMBER_VERSION  Override the reported build version.",
  ].join("\n");
}

export function listenErrorMessage(error: unknown, host: string, port: number): string {
  const address = `${host}:${port}`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    return [
      `AMBER cannot start: ${address} is already in use.`,
      "Another AMBER server may already be running. Stop it, or start on a different port",
      `with PORT=${port + 1} amber.`,
    ].join("\n");
  }
  if (code === "EACCES") {
    return [
      `AMBER cannot start: no permission to bind ${address}.`,
      "Ports below 1024 usually need elevated privileges; pick a higher port with",
      "PORT=3000 amber.",
    ].join("\n");
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `AMBER cannot start: failed to listen on ${address}. ${detail}`;
}

export function startupErrorMessage(error: unknown, settingsPath: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = `${settingsPath}: `;
  if (detail.startsWith(prefix)) {
    return [
      `AMBER cannot start: ${settingsPath} is not valid.`,
      detail.slice(prefix.length),
      `Edit ${settingsPath} and run amber again.`,
    ].join("\n");
  }
  return [
    `AMBER cannot start: ${detail}`,
    `Check ${settingsPath} and run amber again.`,
  ].join("\n");
}
