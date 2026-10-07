import test from "node:test";
import assert from "node:assert/strict";
import { PendingToolRequests } from "../src/pending-tool-request.js";

interface Payload {
  id: number;
}

class TestRequests extends PendingToolRequests<string, Payload> {
  constructor() {
    super({
      abort: "request aborted",
      alreadyPending: "already pending",
      gone: "request gone",
    });
  }

  open(sessionId: string, toolUseId: string, payload: Payload, signal: AbortSignal): Promise<string> {
    return this.register(sessionId, toolUseId, payload, signal);
  }

  settleWith(sessionId: string, toolUseId: string, value: string): void {
    this.settle(sessionId, toolUseId, value);
  }

  fail(sessionId: string, toolUseId: string, error: Error): void {
    this.settle(sessionId, toolUseId, undefined, error);
  }

  payload(sessionId: string, toolUseId: string): Payload {
    return this.payloadOrThrow(sessionId, toolUseId);
  }

  peekPending(sessionId: string): { toolUseId: string; payload: Payload } | undefined {
    return this.peek(sessionId);
  }
}

function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => assert.fail("expected the request to reject"),
    (error: unknown) => error as Error,
  );
}

test("register resolves when the request is settled with a value", async () => {
  const requests = new TestRequests();
  const promise = requests.open("session", "tool-1", { id: 1 }, new AbortController().signal);

  requests.settleWith("session", "tool-1", "answer");

  assert.equal(await promise, "answer");
});

test("settle rejects the request with the supplied error", async () => {
  const requests = new TestRequests();
  const promise = requests.open("session", "tool-1", { id: 1 }, new AbortController().signal);

  requests.fail("session", "tool-1", new Error("declined"));

  const error = await rejectionOf(promise);
  assert.equal(error.message, "declined");
});

test("settle is idempotent", async () => {
  const requests = new TestRequests();
  const promise = requests.open("session", "tool-1", { id: 1 }, new AbortController().signal);

  requests.settleWith("session", "tool-1", "first");
  requests.settleWith("session", "tool-1", "second");

  assert.equal(await promise, "first");
  assert.equal(requests.peekPending("session"), undefined);
});

test("settle for a different toolUseId leaves the request pending", async () => {
  const requests = new TestRequests();
  const promise = requests.open("session", "tool-1", { id: 1 }, new AbortController().signal);
  let settled = false;
  void promise.then(() => { settled = true; });

  requests.settleWith("session", "tool-2", "wrong");
  await Promise.resolve();

  assert.equal(settled, false);
  assert.deepEqual(requests.peekPending("session"), { toolUseId: "tool-1", payload: { id: 1 } });

  requests.settleWith("session", "tool-1", "right");
  assert.equal(await promise, "right");
});

test("aborting the signal rejects with the configured AbortError", async () => {
  const requests = new TestRequests();
  const controller = new AbortController();
  const promise = requests.open("session", "tool-1", { id: 1 }, controller.signal);

  controller.abort();
  const error = await rejectionOf(promise);

  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "request aborted");
  assert.equal(requests.peekPending("session"), undefined);
});

test("registering with an already-aborted signal rejects without occupying the session", async () => {
  const requests = new TestRequests();
  const controller = new AbortController();
  controller.abort();

  const error = await rejectionOf(
    requests.open("session", "tool-1", { id: 1 }, controller.signal),
  );
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "request aborted");

  const retry = requests.open("session", "tool-2", { id: 2 }, new AbortController().signal);
  requests.settleWith("session", "tool-2", "ok");
  assert.equal(await retry, "ok");
});

test("registering a second request for the same session throws alreadyPending", async () => {
  const requests = new TestRequests();
  const first = requests.open("session", "tool-1", { id: 1 }, new AbortController().signal);

  assert.throws(
    () => requests.open("session", "tool-2", { id: 2 }, new AbortController().signal),
    /already pending/,
  );

  requests.settleWith("session", "tool-1", "done");
  assert.equal(await first, "done");

  const second = requests.open("session", "tool-2", { id: 2 }, new AbortController().signal);
  requests.settleWith("session", "tool-2", "next");
  assert.equal(await second, "next");
});

test("payloadOrThrow returns the payload and throws gone for missing or stale ids", async () => {
  const requests = new TestRequests();
  const promise = requests.open("session", "tool-1", { id: 7 }, new AbortController().signal);

  assert.deepEqual(requests.payload("session", "tool-1"), { id: 7 });
  assert.throws(() => requests.payload("session", "other"), /request gone/);
  assert.throws(() => requests.payload("missing", "tool-1"), /request gone/);

  requests.settleWith("session", "tool-1", "value");
  assert.equal(await promise, "value");
  assert.throws(() => requests.payload("session", "tool-1"), /request gone/);
});

test("stopAll rejects every pending request across sessions", async () => {
  const requests = new TestRequests();
  const first = requests.open("session-1", "tool-1", { id: 1 }, new AbortController().signal);
  const second = requests.open("session-2", "tool-2", { id: 2 }, new AbortController().signal);

  requests.stopAll();

  for (const error of await Promise.all([rejectionOf(first), rejectionOf(second)])) {
    assert.equal(error.name, "AbortError");
    assert.equal(error.message, "request aborted");
  }
  assert.equal(requests.peekPending("session-1"), undefined);
  assert.equal(requests.peekPending("session-2"), undefined);
});

test("peek returns the pending request and undefined when empty", async () => {
  const requests = new TestRequests();
  assert.equal(requests.peekPending("session"), undefined);

  const promise = requests.open("session", "tool-1", { id: 3 }, new AbortController().signal);
  assert.deepEqual(requests.peekPending("session"), { toolUseId: "tool-1", payload: { id: 3 } });

  requests.settleWith("session", "tool-1", "value");
  assert.equal(await promise, "value");
  assert.equal(requests.peekPending("session"), undefined);
});
