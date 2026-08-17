import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceStreamingWord,
  BottomScrollPin,
  countStreamingWords,
  StreamingThinkingReveal,
} from "../src/streaming-thinking.js";

test("counts whitespace-delimited streaming words", () => {
  assert.equal(countStreamingWords("  one\ttwo\nthree\r\nfour  "), 4);
});

test("advances through exactly one whole word", () => {
  const value = "  one  two";
  const first = advanceStreamingWord(value, 0);
  assert.equal(value.slice(0, first), "  one");
  assert.equal(value.slice(0, advanceStreamingWord(value, first)), value);
});

test("reveals buffered thinking smoothly without exposing partial words", () => {
  const frames: string[] = [];
  const reveal = new StreamingThinkingReveal((displayed) => frames.push(displayed));
  reveal.update("one two three", 0);

  reveal.tick();
  assert.deepEqual(frames, ["one"]);

  reveal.tick();
  assert.equal(frames.at(-1), "one two three");
});

test("resumes from an existing thinking snapshot without replaying it", () => {
  const frames: string[] = [];
  const reveal = new StreamingThinkingReveal((displayed) => frames.push(displayed));
  reveal.resume("one two", 0);
  assert.deepEqual(frames, ["one two"]);

  reveal.update("one two three", 1_000);
  reveal.tick(1_000);
  assert.equal(frames.at(-1), "one two three");
  assert.equal(frames.includes("one"), false);
});

test("streaming thinking follows the bottom until the user scrolls away and returns", () => {
  const pin = new BottomScrollPin();
  assert.equal(pin.shouldFollowBottom(), true);

  pin.update(120, 200, 500);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.update(293, 200, 500);
  assert.equal(pin.shouldFollowBottom(), true);
});

test("programmatic bottom scroll stays pinned when content lands before the scroll event", () => {
  const pin = new BottomScrollPin();
  const element = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
  pin.scrollToBottom(element);
  assert.equal(element.scrollTop, 300);

  // Scroll events dispatch a frame late: stale scrollTop, grown scrollHeight.
  pin.update(300, 200, 700);
  assert.equal(pin.shouldFollowBottom(), true);

  pin.update(300, 200, 900);
  assert.equal(pin.shouldFollowBottom(), true);
});

test("user scrolling away from a programmatic bottom scroll still unpins", () => {
  const pin = new BottomScrollPin();
  const element = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
  pin.scrollToBottom(element);

  pin.update(150, 200, 500);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.update(300, 200, 500);
  assert.equal(pin.shouldFollowBottom(), true);
});
