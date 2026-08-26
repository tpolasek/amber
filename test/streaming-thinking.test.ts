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

  pin.update(120, 200, 500, true);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.update(293, 200, 500);
  assert.equal(pin.shouldFollowBottom(), true);
});

test("scrolling to the bottom re-enables following", () => {
  const pin = new BottomScrollPin();
  const element = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
  pin.update(100, 200, 500, true);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.scrollToBottom(element);
  assert.equal(element.scrollTop, 300);
  pin.update(300, 200, 500);
  assert.equal(pin.shouldFollowBottom(), true);
});

test("user scrolling up after a programmatic bottom scroll still unpins", () => {
  const pin = new BottomScrollPin();
  const element = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
  pin.scrollToBottom(element);

  pin.update(150, 200, 500, true);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.update(300, 200, 500);
  assert.equal(pin.shouldFollowBottom(), true);
});

test("layout growth and anchoring after a programmatic scroll do not unpin", () => {
  const pin = new BottomScrollPin();
  const element = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
  pin.scrollToBottom(element);

  // Content expands after the snap (tool diff or image finishes loading).
  pin.update(300, 200, 800);
  assert.equal(pin.shouldFollowBottom(), true);
  // Scroll anchoring nudges scrollTop upward while earlier content settles.
  pin.update(297, 200, 800);
  assert.equal(pin.shouldFollowBottom(), true);

  pin.update(100, 200, 800, true);
  assert.equal(pin.shouldFollowBottom(), false);
});

test("reset explicitly restores sticky mode", () => {
  const pin = new BottomScrollPin();
  pin.update(100, 200, 500, true);
  assert.equal(pin.shouldFollowBottom(), false);

  pin.reset();
  assert.equal(pin.shouldFollowBottom(), true);
});
