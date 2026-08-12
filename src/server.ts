import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./store.js";
import { createProvider } from "./provider.js";
import type { Message, ProviderMessage, TokenUsage } from "./types.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "../..");
const publicDirectory = join(projectRoot, "public");
const clientScript = join(sourceDirectory, "client.js");
const dataDirectory = resolve(process.env.DATA_DIR ?? join(projectRoot, "data", "sessions"));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const store = new SessionStore(dataDirectory);
const provider = createProvider(process.env);
const activeSessions = new Set<string>();

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

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
  if (method === "GET" && sessionMatch?.[1]) {
    const session = await store.get(sessionMatch[1]);
    return session ? json(response, 200, { session }) : json(response, 404, { error: "Session not found" });
  }

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/messages$/);
  if (method === "POST" && messageMatch?.[1]) {
    return streamMessage(request, response, messageMatch[1]);
  }

  if (method === "GET" && url.pathname === "/app.js") {
    return serveFile(response, clientScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/styles.css") {
    return serveFile(response, join(publicDirectory, "styles.css"), "text/css; charset=utf-8");
  }
  if (method === "GET" && (url.pathname === "/" || /^\/s\/[a-f0-9-]{36}$/.test(url.pathname))) {
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
  if (session.messages.length === 2) session.title = titleFrom(content);
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
    const history: ProviderMessage[] = session.messages
      .filter((message) => message.id !== assistantMessage.id && message.status === "complete")
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }));
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

function titleFrom(content: string): string {
  const firstLine = content.split("\n")[0]?.trim() ?? content;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider error";
}
