import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  api,
  authMutation,
  settingsMutation,
  responseError,
  readEventStream,
  requiredWithin,
  setAuthActionTokenProvider,
} from "../src/client-api.js";

const originalFetch = globalThis.fetch;

type FetchCall = { input: RequestInfo | URL; init: RequestInit | undefined };
let calls: FetchCall[] = [];

function stubFetch(response: Response): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return response;
  }) as typeof fetch;
}

function requestHeaders(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("api returns the parsed JSON body on success", async () => {
  stubFetch(new Response(JSON.stringify({ answer: 42 }), { status: 200 }));

  const result = await api<{ answer: number }>("/api/answer", { method: "POST", body: "{}" });

  assert.deepEqual(result, { answer: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/answer");
  assert.equal(requestHeaders(calls[0]!)["content-type"], "application/json");
});

test("api sends default and caller headers together", async () => {
  stubFetch(new Response("{}", { status: 200 }));

  await api("/api/answer", { headers: { "x-custom": "1" } });

  const headers = requestHeaders(calls[0]!);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-custom"], "1");
});

test("api throws the server's error message on a failed response", async () => {
  stubFetch(new Response(JSON.stringify({ error: "No such session" }), { status: 404 }));

  await assert.rejects(() => api("/api/sessions/missing"), /No such session/);
});

test("authMutation attaches the action token and forwards caller headers", async () => {
  setAuthActionTokenProvider(() => "secret-token");
  stubFetch(new Response("{}", { status: 200 }));

  await authMutation("/api/auth", { method: "POST", body: "{}", headers: { "x-custom": "1" } });

  const headers = requestHeaders(calls[0]!);
  assert.equal(headers["x-amber-auth-action-token"], "secret-token");
  assert.equal(headers["x-custom"], "1");
  assert.equal(headers["content-type"], "application/json");
});

test("authMutation refuses to run without an initialized token", async () => {
  setAuthActionTokenProvider(() => undefined);
  calls = [];

  await assert.rejects(
    () => authMutation("/api/auth", { method: "POST" }),
    /Authentication settings are not initialized/,
  );
  assert.equal(calls.length, 0);
});

test("settingsMutation attaches the action token and reports its own missing-token error", async () => {
  setAuthActionTokenProvider(() => "settings-token");
  stubFetch(new Response("{}", { status: 200 }));
  await settingsMutation("/api/settings", { method: "PUT", body: "{}" });
  assert.equal(requestHeaders(calls[0]!)["x-amber-auth-action-token"], "settings-token");

  setAuthActionTokenProvider(() => undefined);
  await assert.rejects(
    () => settingsMutation("/api/settings", { method: "PUT" }),
    /Settings are not initialized/,
  );
});

test("responseError prefers the JSON error field", async () => {
  assert.equal(
    await responseError(new Response(JSON.stringify({ error: "Disk is full" }), { status: 500 })),
    "Disk is full",
  );
});

test("responseError falls back to a status message for missing or unparseable bodies", async () => {
  assert.equal(await responseError(new Response(JSON.stringify({}), { status: 500 })), "Request failed (500)");
  assert.equal(await responseError(new Response("not json", { status: 503 })), "Request failed (503)");
});

test("readEventStream parses SSE frames and JSON payloads, including a split frame", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: delta\ndata: {"text":"hel'));
      controller.enqueue(encoder.encode('lo"}\n\n'));
      controller.enqueue(encoder.encode('event: done\ndata: {"ok":true}\n\n'));
      controller.close();
    },
  });

  const events: Array<{ event: string; data: unknown }> = [];
  await readEventStream(stream, (event, data) => events.push({ event, data }));

  assert.deepEqual(events, [
    { event: "delta", data: { text: "hello" } },
    { event: "done", data: { ok: true } },
  ]);
});

test("readEventStream yields a trailing frame without a blank-line terminator", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"final":true}'));
      controller.close();
    },
  });

  const events: Array<{ event: string; data: unknown }> = [];
  await readEventStream(stream, (event, data) => events.push({ event, data }));

  assert.deepEqual(events, [{ event: "message", data: { final: true } }]);
});

test("requiredWithin returns the matching descendant and throws on a miss", () => {
  const element = { className: "target" };
  const parent = {
    querySelector: (selector: string) => (selector === ".target" ? element : null),
  } as unknown as ParentNode;

  assert.equal(requiredWithin(parent, ".target"), element);
  assert.throws(() => requiredWithin(parent, ".missing"), /Missing \.missing/);
});
