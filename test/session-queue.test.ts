import test from "node:test";
import assert from "node:assert/strict";
import { SessionInputPriorityQueue } from "../src/session-queue.js";

test("takes returns and removes the queued message", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "stop after this one", kind: "message" });

  assert.deepEqual(queue.takeReady("session"), [{
    content: "stop after this one", kind: "message", priority: 2, source: "user",
  }]);
  assert.deepEqual(queue.takeReady("session"), []);
});

test("queuing again replaces a message that has not been delivered", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "first", kind: "message" });
  queue.enqueueUser("session", { content: "/context", kind: "command" });

  assert.deepEqual(queue.takeReady("session"), [{
    content: "/context", kind: "command", priority: 2, source: "user",
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

test("automatic compaction waits for an operation and has top priority", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueUser("session", { content: "user input", kind: "message" });
  queue.enqueueAutomaticCompaction("session");
  assert.equal(queue.takeReady("session")[0]?.source, "user");

  queue.operationCompleted("session");
  assert.equal(queue.takeReady("session")[0]?.source, "automatic-compaction");
});

test("ready compaction sorts before user input regardless of enqueue order", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueAutomaticCompaction("session");
  queue.enqueueUser("session", { content: "user input", kind: "message" });
  queue.operationCompleted("session");

  assert.deepEqual(queue.takeReady("session").map((entry) => entry.source), ["automatic-compaction", "user"]);
});

test("successful automatic compaction can remove a redundant manual compact", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueAutomaticCompaction("session");
  queue.enqueueUser("session", { content: "/COMPACT", kind: "command" });

  assert.equal(queue.removeManualCompaction("session"), true);
  queue.operationCompleted("session");
  assert.deepEqual(queue.takeReady("session").map((entry) => entry.source), ["automatic-compaction"]);
});

test("removing a manual compact preserves other queued commands", () => {
  const queue = new SessionInputPriorityQueue();
  queue.enqueueAutomaticCompaction("session");
  queue.enqueueUser("session", { content: "/name keep-me", kind: "command" });

  assert.equal(queue.removeManualCompaction("session"), false);
  queue.operationCompleted("session");
  assert.deepEqual(queue.takeReady("session").map((entry) => entry.content), ["/compact", "/name keep-me"]);
});
