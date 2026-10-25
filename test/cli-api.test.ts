import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AmberApi } from "../src/cli/api.js";

interface Captured { method: string; url: string; body: any }

function startApiStub(): Promise<{ server: Server; captured: Captured[]; respond: (handler: (captured: Captured) => unknown) => void; port: number }> {
  const captured: Captured[] = [];
  let handler: (captured: Captured) => unknown = () => ({});
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk; });
    request.on("end", () => {
      const entry = { method: request.method!, url: request.url!, body: body === "" ? undefined : JSON.parse(body) };
      captured.push(entry);
      const result = handler(entry);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        captured,
        respond: (next: (captured: Captured) => unknown) => { handler = next; },
        port: address.port,
      });
    });
  });
}

test("listSessions returns the sessions array", async () => {
  const stub = await startApiStub();
  stub.respond(() => ({ sessions: [{ id: "s1", title: "T", createdAt: "", updatedAt: "", messageCount: 1, preview: "" }] }));
  const api = new AmberApi(`http://127.0.0.1:${stub.port}`);
  const sessions = await api.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(stub.captured[0]!.url, "/api/sessions");
  stub.server.close();
});

test("sendMessage posts content and drains the stream body", async () => {
  const stub = await startApiStub();
  const api = new AmberApi(`http://127.0.0.1:${stub.port}`);
  await api.sendMessage("abc", "hello");
  assert.deepEqual(stub.captured[0], { method: "POST", url: "/api/sessions/abc/messages", body: { content: "hello" } });
  stub.server.close();
});

test("queuedMessage reports busy on 409", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "wait" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = new AmberApi(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  assert.equal(await api.queuedMessage("s", "later", "message"), "busy");
  server.close();
});

test("request failures throw the server error message", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "no such command" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = new AmberApi(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await assert.rejects(() => api.command("s", "/nope"), /no such command/);
  server.close();
});

test("answerQuestions posts answers keyed by question text", async () => {
  const stub = await startApiStub();
  const api = new AmberApi(`http://127.0.0.1:${stub.port}`);
  await api.answerQuestions("s", "tool-1", { "Pick?": "One" });
  assert.equal(stub.captured[0]!.url, "/api/sessions/s/questions/tool-1/answers");
  assert.deepEqual(stub.captured[0]!.body, { answers: { "Pick?": "One" } });
  await api.answerQuestions("s", "tool-1", { cancelled: true });
  assert.deepEqual(stub.captured[1]!.body, { cancelled: true });
  stub.server.close();
});

test("planDecision posts the decision body", async () => {
  const stub = await startApiStub();
  const api = new AmberApi(`http://127.0.0.1:${stub.port}`);
  await api.planDecision("s", "tool-2", { newSession: true });
  assert.deepEqual(stub.captured[0]!.body, { newSession: true });
  stub.server.close();
});

test("history requests the pagination cursor", async () => {
  const stub = await startApiStub();
  stub.respond(() => ({ messages: [], hasMore: false }));
  const api = new AmberApi(`http://127.0.0.1:${stub.port}`);
  await api.history("s", "m-9");
  assert.equal(stub.captured[0]!.url, "/api/sessions/s/messages?before=m-9");
  stub.server.close();
});
