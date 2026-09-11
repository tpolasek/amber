import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_PAGE_SIZE, pageSessionMessages, paginateSession } from "../src/session-pagination.js";
import type { Message, Session } from "../src/types.js";

const now = new Date().toISOString();

function message(id: string, kind?: Message["kind"]): Message {
  return { id, role: kind === "tool-result" ? "user" : "assistant", content: id, createdAt: now, status: "complete", ...(kind ? { kind } : {}) };
}

/** `pairs` assistant sections, each followed by its tool-result attachment. */
function sectionedMessages(pairs: number): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < pairs; index += 1) {
    messages.push(message(`a${index}`), message(`t${index}`, "tool-result"));
  }
  return messages;
}

test("the latest page carries the newest sections and reports more history", () => {
  const messages = sectionedMessages(SESSION_PAGE_SIZE + 10);
  const page = pageSessionMessages(messages);
  const expected: string[] = [];
  for (let index = 10; index < SESSION_PAGE_SIZE + 10; index += 1) expected.push(`a${index}`, `t${index}`);
  assert.deepEqual(page.messages.map((m) => m.id), expected);
  assert.equal(page.hasMore, true);
});

test("a full session fits in one page", () => {
  const messages = sectionedMessages(3);
  const page = pageSessionMessages(messages);
  assert.deepEqual(page.messages, messages);
  assert.equal(page.hasMore, false);
});

test("pages never split a message from its tool results", () => {
  // Enough sections to force a boundary: the page must start at a rendered
  // message and every attachment must sit behind its own section.
  const messages = sectionedMessages(SESSION_PAGE_SIZE + 4);
  const page = pageSessionMessages(messages);
  assert.notEqual(page.messages.length, 0);
  assert.equal(page.messages[0]!.kind, undefined, "page must start at a rendered message");
  for (let index = 1; index < page.messages.length; index += 1) {
    const previous = page.messages[index - 1]!;
    const current = page.messages[index]!;
    if (current.kind === "tool-result") {
      assert.ok(previous.kind === "tool-result" || previous.role === "assistant",
        "tool results must directly follow their section");
    }
  }
});

test("the before cursor pages strictly older sections", () => {
  const messages = sectionedMessages(12); // far below the page size
  const first = pageSessionMessages(messages);
  assert.equal(first.hasMore, false);
  const earlier = pageSessionMessages(messages, first.messages[0]!.id);
  assert.deepEqual(earlier.messages, []);
  assert.equal(earlier.hasMore, false);

  const many = sectionedMessages(SESSION_PAGE_SIZE + 12);
  const latest = pageSessionMessages(many);
  const next = pageSessionMessages(many, latest.messages[0]!.id);
  assert.deepEqual(next.messages, many.slice(0, 24), "the second page is everything before the latest page");
  assert.equal(next.hasMore, false);
});

test("an unknown cursor yields an empty page instead of a wrong one", () => {
  const messages = sectionedMessages(5);
  const page = pageSessionMessages(messages, "does-not-exist");
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
});

test("hidden-only tails stay attached to their section", () => {
  const messages: Message[] = [
    ...sectionedMessages(1),
    message("a1"),
    message("t1", "tool-result"),
    message("skill-1", "skill"),
    message("a2"),
    message("t2", "tool-result"),
  ];
  const page = pageSessionMessages(messages, "a2");
  assert.deepEqual(page.messages.map((m) => m.id), ["a0", "t0", "a1", "t1", "skill-1"]);
  assert.equal(page.hasMore, false);
});

test("paginateSession pages without mutating the source session", () => {
  const session: Session = {
    id: "session",
    title: "session",
    createdAt: now,
    updatedAt: now,
    messages: sectionedMessages(SESSION_PAGE_SIZE + 2),
  };
  const page = paginateSession(session);
  assert.equal(page.session.messages.length, SESSION_PAGE_SIZE * 2);
  assert.equal(page.hasMore, true);
  assert.equal(session.messages.length, (SESSION_PAGE_SIZE + 2) * 2, "source messages untouched");
  assert.equal(page.session.id, session.id);
  assert.notEqual(page.session, session);
});
