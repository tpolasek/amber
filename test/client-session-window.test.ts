import test from "node:test";
import assert from "node:assert/strict";
import {
  applySessionPage,
  isRenderedMessage,
  mergeSessionPage,
  resetSessionWindow,
  sessionWindow,
} from "../src/client-session-window.js";
import type { Message, Session } from "../src/client-types.js";

const now = new Date().toISOString();

function message(id: string, kind?: Message["kind"]): Message {
  return { id, role: "user", content: id, createdAt: now, status: "complete", ...(kind ? { kind } : {}) };
}

function session(id: string, messages: Message[]): Session {
  return { id, title: id, createdAt: now, updatedAt: now, messages };
}

test("a page overlapping the loaded window keeps the older loaded prefix", () => {
  const loaded = session("s", [message("m1"), message("m2"), message("m3", "tool-result"), message("m4")]);
  // The server page ends at the newest message and starts inside the window.
  const page = session("s", [message("m2"), message("m3", "tool-result"), message("m4"), message("m5")]);
  const merged = mergeSessionPage(loaded, page);
  assert.equal(merged.mergedWithLoaded, true);
  assert.deepEqual(merged.session.messages.map((m) => m.id), ["m1", "m2", "m3", "m4", "m5"]);
  // Page metadata wins (title, context, and so on).
  assert.equal(merged.session.id, "s");
});

test("a page that no longer overlaps replaces the window", () => {
  const loaded = session("s", [message("m1"), message("m2")]);
  const page = session("s", [message("m9"), message("m10")]);
  const merged = mergeSessionPage(loaded, page);
  assert.equal(merged.mergedWithLoaded, false);
  assert.deepEqual(merged.session.messages.map((m) => m.id), ["m9", "m10"]);
});

test("a different session replaces the window", () => {
  const loaded = session("old", [message("m1")]);
  const page = session("new", [message("f1"), message("f2")]);
  const merged = mergeSessionPage(loaded, page);
  assert.equal(merged.mergedWithLoaded, false);
  assert.deepEqual(merged.session.messages.map((m) => m.id), ["f1", "f2"]);
});

test("an empty page (a cleared session) replaces the window", () => {
  const loaded = session("s", [message("m1"), message("m2")]);
  const merged = mergeSessionPage(loaded, session("s", []));
  assert.equal(merged.mergedWithLoaded, false);
  assert.deepEqual(merged.session.messages, []);
});

test("applySessionPage keeps hasMore for merged windows and adopts it on replace", () => {
  resetSessionWindow(true);
  const loaded = session("s", [message("m1"), message("m2")]);
  const overlapping = applySessionPage(loaded, session("s", [message("m2"), message("m3")]), false);
  assert.equal(overlapping.mergedWithLoaded, true);
  assert.equal(sessionWindow.hasMore, true, "the older prefix is still loaded in front");

  applySessionPage(loaded, session("s", [message("m9")]), false);
  assert.equal(sessionWindow.hasMore, false, "a replaced window adopts the page's hasMore");

  applySessionPage(loaded, session("s", [message("m9")]), true);
  assert.equal(sessionWindow.hasMore, true);
});

test("rendered messages exclude attachments only", () => {
  assert.equal(isRenderedMessage(message("m")), true);
  assert.equal(isRenderedMessage(message("m", "chat")), true);
  assert.equal(isRenderedMessage(message("m", "compact-banner")), true);
  assert.equal(isRenderedMessage(message("m", "fork-banner")), true);
  assert.equal(isRenderedMessage(message("m", "tool-result")), false);
  assert.equal(isRenderedMessage(message("m", "skill")), false);
  assert.equal(isRenderedMessage(message("m", "agent-notification")), false);
});
