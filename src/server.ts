import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./store.js";
import { createProvider } from "./provider.js";
import { buildProviderHistory, isModelMessage } from "./history.js";
import { generateSessionTitle } from "./session-title.js";
import { estimateHistoryTokens, formatCompactionBanner, generateCompactionSummary } from "./compaction.js";
import type { Message, TokenUsage } from "./types.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "../..");
const publicDirectory = join(projectRoot, "public");
const clientScript = join(sourceDirectory, "client.js");
const markdownScript = join(projectRoot, "node_modules", "markdown-it", "dist", "browser", "markdown-it.umd.min.js");
const dataDirectory = resolve(process.env.DATA_DIR ?? join(projectRoot, "data", "sessions"));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const store = new SessionStore(dataDirectory);
const provider = createProvider(process.env);
const activeSessions = new Set<string>();
const SESSION_PATH_ID = "([a-z0-9.-]+)";

await store.initialize();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`\n  AMBER agent online at http://${host}:${port}`);
  console.log(`  provider: ${provider.name} / ${provider.model} (${provider.mode})\n`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname === "/api/config") {
    return json(response, 200, { provider: provider.name, model: provider.model, mode: provider.mode });
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    return json(response, 200, { sessions: await store.list() });
  }
  if (method === "POST" && url.pathname === "/api/sessions") {
    return json(response, 201, { session: await store.create() });
  }

  const sessionMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}$`));
  if (method === "GET" && sessionMatch?.[1]) {
    const session = await store.get(sessionMatch[1]);
    return session ? json(response, 200, { session }) : json(response, 404, { error: "Session not found" });
  }
  if (method === "DELETE" && sessionMatch?.[1]) {
    if (activeSessions.has(sessionMatch[1])) return json(response, 409, { error: "Wait for the current response to finish" });
    const removed = await store.remove(sessionMatch[1]);
    return removed
      ? json(response, 200, { deletedSessionId: sessionMatch[1] })
      : json(response, 404, { error: "Session not found" });
  }

  const messageMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/messages$`));
  if (method === "POST" && messageMatch?.[1]) {
    return streamMessage(request, response, messageMatch[1]);
  }

  const commandMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/commands$`));
  if (method === "POST" && commandMatch?.[1]) {
    return executeCommand(request, response, commandMatch[1]);
  }

  if (method === "GET" && url.pathname === "/app.js") {
    return serveFile(response, clientScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/vendor/markdown-it.js") {
    return serveFile(response, markdownScript, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable");
  }
  if (method === "GET" && url.pathname === "/styles.css") {
    return serveFile(response, join(publicDirectory, "styles.css"), "text/css; charset=utf-8");
  }
  if (method === "GET" && (url.pathname === "/" || /^\/s\/[a-z0-9.-]+$/.test(url.pathname))) {
    return serveFile(response, join(publicDirectory, "index.html"), "text/html; charset=utf-8", "no-cache");
  }
  json(response, 404, { error: "Not found" });
}

async function streamMessage(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
  if (activeSessions.has(sessionId)) return json(response, 409, { error: "A response is already streaming" });
  const session = await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });

  const body = await readJson(request);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content || content.length > 32_000) return json(response, 400, { error: "Message must contain 1–32,000 characters" });

  const now = new Date().toISOString();
  const userMessage: Message = { id: randomUUID(), role: "user", content, createdAt: now, status: "complete" };
  const assistantMessage: Message = { id: randomUUID(), role: "assistant", content: "", createdAt: now, status: "streaming" };
  session.messages.push(userMessage, assistantMessage);
  await store.save(session);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  sendEvent(response, "start", { userMessage, assistantMessage });
  activeSessions.add(sessionId);
  const controller = new AbortController();
  request.on("aborted", () => controller.abort());
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const history = buildProviderHistory(session.messages, assistantMessage.id, session.compaction);
    let usage: Partial<TokenUsage> = {};
    for await (const event of provider.stream(history, controller.signal)) {
      if (event.type === "delta") {
        assistantMessage.content += event.text;
        sendEvent(response, "delta", { text: event.text });
      } else if (event.type === "usage") {
        usage = { ...usage, ...event.usage };
      }
    }
    assistantMessage.status = "complete";
    if (usage.input !== undefined && usage.output !== undefined) assistantMessage.usage = usage as TokenUsage;
    await store.save(session);
    sendEvent(response, "done", { message: assistantMessage, session });
  } catch (error) {
    assistantMessage.status = "error";
    if (!assistantMessage.content) assistantMessage.content = "Response interrupted.";
    await store.save(session);
    const message = error instanceof Error && error.name === "AbortError" ? "Generation stopped" : errorMessage(error);
    if (!response.writableEnded) sendEvent(response, "error", { error: message, message: assistantMessage });
  } finally {
    activeSessions.delete(sessionId);
    response.end();
  }
}

async function executeCommand(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
  if (activeSessions.has(sessionId)) return json(response, 409, { error: "Wait for the current response to finish" });
  const session = await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });
  const body = await readJson(request);
  const rawCommand = typeof body.command === "string" ? body.command.trim() : "";
  const firstWhitespace = rawCommand.search(/\s/);
  const command = (firstWhitespace === -1 ? rawCommand : rawCommand.slice(0, firstWhitespace)).toLowerCase();
  const argument = firstWhitespace === -1 ? "" : rawCommand.slice(firstWhitespace).trim();

  if (command === "/name") {
    if (argument) {
      const title = argument.replace(/\s+/g, " ").trim();
      if (title.length > 80) return json(response, 400, { error: "Session names must be 80 characters or fewer" });
      return json(response, 200, { command: "name", session: await store.rename(session, title) });
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    activeSessions.add(sessionId);
    try {
      const title = await generateSessionTitle(provider, session.messages, controller.signal, session.compaction);
      return json(response, 200, { command: "name", session: await store.rename(session, title) });
    } catch (error) {
      return json(response, 502, { error: errorMessage(error) });
    } finally {
      activeSessions.delete(sessionId);
    }
  }

  if (argument) return json(response, 400, { error: `${command} does not accept arguments` });

  if (command === "/clear") {
    return json(response, 200, { command: "clear", session: await store.clear(session) });
  }
  if (command === "/compact") {
    const previousBoundary = session.compaction
      ? session.messages.findIndex((message) => message.id === session.compaction?.throughMessageId)
      : -1;
    const newModelMessages = session.messages
      .slice(previousBoundary + 1)
      .filter((message) => message.status === "complete" && isModelMessage(message));
    const throughMessage = newModelMessages.at(-1);
    if (!throughMessage) {
      return json(response, 400, { error: session.compaction ? "No new conversation to compact" : "No conversation to compact" });
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    activeSessions.add(sessionId);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sendEvent(response, "start", { message: "Compacting model context…" });
    try {
      const history = buildProviderHistory(session.messages, undefined, session.compaction);
      const beforeTokens = estimateHistoryTokens(history);
      const summary = await generateCompactionSummary(provider, history, controller.signal, (generatedCharacters) => {
        if (!response.destroyed && !response.writableEnded) {
          sendEvent(response, "progress", { generatedCharacters });
        }
      });
      const now = new Date().toISOString();
      const coveredMessageCount = session.messages
        .slice(0, session.messages.findIndex((message) => message.id === throughMessage.id) + 1)
        .filter((message) => message.status === "complete" && isModelMessage(message)).length;
      const compaction = {
        summary,
        throughMessageId: throughMessage.id,
        createdAt: now,
        coveredMessageCount,
      };
      const afterTokens = estimateHistoryTokens(buildProviderHistory(session.messages, undefined, compaction));
      session.compaction = compaction;
      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: formatCompactionBanner(beforeTokens, afterTokens, coveredMessageCount),
        createdAt: now,
        status: "complete",
        kind: "compact-banner",
      });
      await store.save(session);
      if (!response.destroyed && !response.writableEnded) sendEvent(response, "done", { command: "compact", session });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) sendEvent(response, "error", { error: errorMessage(error) });
    } finally {
      activeSessions.delete(sessionId);
      response.end();
    }
    return;
  }
  if (command === "/fork") {
    const now = new Date().toISOString();
    const forkBanner: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `Forked from session: ${session.id}`,
      createdAt: now,
      status: "complete",
      kind: "fork-banner",
      sourceSessionId: session.id,
    };
    const fork = await store.createFork(session, forkBanner);
    const sourceBanner: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `Forked to session: ${fork.id}`,
      createdAt: now,
      status: "complete",
      kind: "fork-banner",
      forkedSessionId: fork.id,
    };
    session.messages.push(sourceBanner);
    await store.save(session);
    return json(response, 201, { command: "fork", session: fork, previousSessionId: session.id });
  }
  if (command === "/context") {
    const chatMessages = session.messages.filter(isModelMessage);
    const activeHistory = buildProviderHistory(session.messages, undefined, session.compaction);
    const assistantMessages = chatMessages.filter((message) => message.role === "assistant" && message.status === "complete");
    const latestUsage = assistantMessages.slice().reverse().find((message) => message.usage)?.usage;
    const totalInput = assistantMessages.reduce((total, message) => total + (message.usage?.input ?? 0), 0);
    const totalOutput = assistantMessages.reduce((total, message) => total + (message.usage?.output ?? 0), 0);
    const currentTokens = (latestUsage?.input ?? 0) + (latestUsage?.output ?? 0);
    const now = new Date().toISOString();
    const userMessage: Message = {
      id: randomUUID(), role: "user", content: command, createdAt: now, status: "complete", kind: "command",
    };
    const assistantMessage: Message = {
      id: randomUUID(),
      role: "assistant",
      content: [
        `**Context · ${session.id}**`,
        "",
        `- Model: \`${provider.model}\``,
        `- Active context: **${currentTokens.toLocaleString()} tokens** (latest measured turn)`,
        `- Latest input / output: **${(latestUsage?.input ?? 0).toLocaleString()} / ${(latestUsage?.output ?? 0).toLocaleString()}**`,
        `- Session input: **${totalInput.toLocaleString()} tokens**`,
        `- Session output: **${totalOutput.toLocaleString()} tokens**`,
        `- Model messages: **${chatMessages.length}**`,
        `- Active provider messages: **${activeHistory.length}**${session.compaction ? ` (summary + messages after compaction)` : ""}`,
        ...(session.compaction ? [`- Compacted messages: **${session.compaction.coveredMessageCount}**`] : []),
      ].join("\n"),
      createdAt: now,
      status: "complete",
      kind: "command",
    };
    session.messages.push(userMessage, assistantMessage);
    await store.save(session);
    return json(response, 200, { command: "context", session });
  }
  return json(response, 400, { error: `Unknown command: ${command || "(empty)"}` });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function serveFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  cacheControl = "public, max-age=3600",
): Promise<void> {
  const content = await readFile(path);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  response.end(content);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider error";
}
