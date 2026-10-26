import { createInterface } from "node:readline/promises";
import type { Session, SessionSummary } from "../types.js";
import { Terminal } from "./term.js";
import { AmberApi } from "./api.js";
import { subscribeSessionEvents, type CliSessionEvent } from "./stream.js";
import { SessionDisplay } from "./display.js";
import { DIM, RED } from "./render.js";

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
    "Local commands: /output [chars] /history [n] /list /new [name] /switch <prefix> /quit.",
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
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`amber cli: ${error instanceof Error ? error.message : String(error)}\n\n${cliUsageText()}\n`);
    return 2;
  }
  if (parsed.kind === "help") {
    process.stdout.write(`${cliUsageText()}\n`);
    return 0;
  }
  const args = parsed.args;
  const term = new Terminal();
  const api = new AmberApi(args.server);
  try {
    if (args.list) return await listSessions(api, term);
    const sessionId = await resolveSessionId(api, args);
    term.line(term.style(`· session ${sessionId.slice(0, 8)}`, DIM));
    return await repl(api, term, sessionId, args);
  } catch (error) {
    term.line(term.style(`✗ ${error instanceof Error ? error.message : String(error)}`, RED));
    term.end();
    return 1;
  }
}

async function listSessions(api: AmberApi, term: Terminal): Promise<number> {
  for (const session of await api.listSessions()) {
    term.line(`${session.id.slice(0, 8)}  ${session.title}  ${session.updatedAt.slice(0, 10)}`);
  }
  term.end();
  return 0;
}

async function resolveSessionId(api: AmberApi, args: CliArgs): Promise<string> {
  if (args.newName !== undefined) {
    const session = await api.createSession(process.cwd(), args.newName === "" ? undefined : args.newName);
    return session.id;
  }
  const sessions = await api.listSessions();
  if (args.session !== undefined) return matchSessionId(sessions, args.session);
  if (sessions.length === 0) {
    const session = await api.createSession(process.cwd());
    return session.id;
  }
  return sessions[0]!.id;
}

export function matchSessionId(sessions: SessionSummary[], prefix: string): string {
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no session matches '${prefix}'`);
  if (matches.length > 1) throw new Error(`session prefix '${prefix}' is ambiguous`);
  return matches[0]!.id;
}

async function repl(api: AmberApi, term: Terminal, sessionId: string, args: CliArgs): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let currentSessionId = sessionId;
  let subscription = new AbortController();
  let display = createDisplay(currentSessionId);

  function createDisplay(id: string): SessionDisplay {
    return new SessionDisplay(term, id, {
      ask: async (prompt) => await rl.question(prompt),
      answerQuestions: (sid, toolUseId, answers) => api.answerQuestions(sid, toolUseId, answers),
      planDecision: async (sid, toolUseId, decision) => { await api.planDecision(sid, toolUseId, decision); },
      onActiveChange: (active) => {
        rl.setPrompt(active ? "" : "> ");
        if (!active) {
          term.flush();
          rl.prompt();
        }
      },
    });
  }

  function switchSession(id: string): void {
    subscription.abort();
    currentSessionId = id;
    subscription = new AbortController();
    display = createDisplay(id);
    rl.setPrompt("> "); // the fresh display starts inactive; a mid-run switch left the prompt blank
    void subscribeSessionEvents(args.server, id, dispatch, subscription.signal);
    term.line(term.style(`· session ${id.slice(0, 8)}`, DIM));
  }

  let eventChain: Promise<void> = Promise.resolve();
  const dispatch = (event: CliSessionEvent) => {
    const target = display;
    eventChain = eventChain
      .then(() => target.applyEvent(event.event, event.data))
      .catch((error) => {
        term.line(term.style(`✗ ${error instanceof Error ? error.message : String(error)}`, RED));
      });
  };
  let lastSigint = 0;
  const exit = (code: number): never => {
    term.end();
    subscription.abort();
    rl.close();
    process.exit(code);
  };
  try {
    void subscribeSessionEvents(args.server, currentSessionId, dispatch, subscription.signal);

    const history = await api.history(currentSessionId);
    display.attach(history.messages, args.history);
    term.flush();

    rl.on("SIGINT", () => {
      const now = Date.now();
      if (now - lastSigint < 1_000) exit(0);
      lastSigint = now;
      if (display.active) {
        void api.abort(currentSessionId).catch(() => undefined);
        term.status(null);
        term.flush();
      } else {
        exit(0);
      }
    });
    process.once("SIGINT", () => exit(130));
    rl.on("close", () => exit(0));
    if (process.stdin.isTTY) process.stdin.on("data", () => term.suppressStatus());
  } catch (error) {
    subscription.abort();
    rl.close();
    throw error;
  }

  rl.on("line", (input) => {
    if (display.gatePending) return; // consumed by a gate's rl.question
    const text = input.trim();
    if (text === "") {
      if (!display.active) rl.prompt();
      return;
    }
    void handleInput(text)
      .catch((error) => {
        term.line(term.style(`✗ ${error instanceof Error ? error.message : String(error)}`, RED));
      })
      .finally(() => {
        term.flush();
        if (!display.active) rl.prompt();
      });
  });

  async function handleInput(text: string): Promise<void> {
    if (text === "/quit") exit(0);
    if (text === "/list") {
      for (const session of await api.listSessions()) {
        term.line(`${session.id.slice(0, 8)}  ${session.title}  ${session.updatedAt.slice(0, 10)}`);
      }
      return;
    }
    if (text === "/output" || text.startsWith("/output ")) {
      const chars = numberArgument(text, 2_000);
      const output = display.latestToolOutput();
      term.line(output === null ? term.style("· no completed tool call yet", DIM) : output.slice(-chars));
      return;
    }
    if (text === "/history" || text.startsWith("/history ")) {
      const count = numberArgument(text, 5);
      const page = await api.history(currentSessionId, display.oldestPrintedId());
      display.attach(page.messages, count);
      return;
    }
    if (text === "/new" || text.startsWith("/new ")) {
      const name = text.split(/\s+/).slice(1).join(" ");
      const session: Session = await api.createSession(process.cwd(), name === "" ? undefined : name);
      switchSession(session.id);
      return;
    }
    if (text === "/switch" || text.startsWith("/switch ")) {
      const prefix = text.split(/\s+/)[1] ?? "";
      if (prefix === "") throw new Error("/switch requires a session id prefix (see /list)");
      switchSession(matchSessionId(await api.listSessions(), prefix));
      const page = await api.history(currentSessionId);
      display.attach(page.messages, args.history);
      return;
    }
    if (text.startsWith("/")) {
      if (display.active) await queue(api, term, currentSessionId, text, "command");
      else {
        await api.command(currentSessionId, text);
        term.line(term.style("· done", DIM));
      }
      return;
    }
    if (display.active) await queue(api, term, currentSessionId, text, "message");
    else await api.sendMessage(currentSessionId, text);
  }

  rl.prompt();
  return await new Promise<number>(() => undefined); // exits via exit()
}

async function queue(
  api: AmberApi,
  term: Terminal,
  sessionId: string,
  content: string,
  kind: "message" | "command",
): Promise<void> {
  const result = await api.queuedMessage(sessionId, content, kind);
  if (result === "queued") term.line(term.style("· queued", DIM));
  else term.line(term.style("· run ended before queueing; send again", DIM));
}

function numberArgument(text: string, fallback: number): number {
  const value = Number(text.split(/\s+/)[1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
