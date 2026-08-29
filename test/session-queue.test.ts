import test from "node:test";
import assert from "node:assert/strict";
import { SessionInputPriorityQueue } from "../src/session-queue.js";

test("takes returns and removes the queued message", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "stop after this one", kind: "message" });

  assert.deepEqual(queue.takeReady("session"), [{
    content: "stop after this one", kind: "message", priority: 2,
  }]);
  assert.deepEqual(queue.takeReady("session"), []);
});

test("queuing again replaces a message that has not been delivered", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "first", kind: "message" });
  queue.enqueueUser("session", { content: "/context", kind: "command" });

  assert.deepEqual(queue.takeReady("session"), [{
    content: "/context", kind: "command", priority: 2,
  }]);
});

test("keeps messages of other sessions separate", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("one", { content: "first message", kind: "message" });
  queue.enqueueUser("two", { content: "second message", kind: "message" });

  assert.equal(queue.takeReady("two")[0]?.content, "second message");
  assert.equal(queue.takeReady("one")[0]?.content, "first message");
});

test("clear drops an undelivered message", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "never mind", kind: "message" });
  queue.clear("session");

  assert.deepEqual(queue.takeReady("session"), []);
});

test("server compaction sorts before user input regardless of enqueue order", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "user input", kind: "message" });
  queue.enqueueCompaction("session");

  assert.deepEqual(queue.takeReady("session").map((entry) => entry.content), ["/compact", "user input"]);
});

test("replacing the user slot keeps a queued compaction", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueCompaction("session");
  queue.enqueueUser("session", { content: "first", kind: "message" });
  queue.enqueueUser("session", { content: "second", kind: "message" });

  assert.deepEqual(queue.takeReady("session").map((entry) => entry.content), ["/compact", "second"]);
});

test("enqueueCompaction is a no-op when a server compact is already queued", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueCompaction("session");
  queue.enqueueCompaction("session");

  assert.deepEqual(queue.takeReady("session").map((entry) => entry.content), ["/compact"]);
});

test("enqueueCompaction is a no-op when a user compact is already queued", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "/COMPACT", kind: "command" });
  queue.enqueueCompaction("session");

  assert.deepEqual(queue.takeReady("session").map((entry) => entry.content), ["/COMPACT"]);
});
