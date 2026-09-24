import test from "node:test";
import assert from "node:assert/strict";
import { btwSystemReminder, parseBtwInput } from "../src/btw.js";

test("strictly parses side-question input", () => {
  assert.deepEqual(parseBtwInput({ question: "  What broke?  " }), { question: "What broke?" });
  assert.throws(() => parseBtwInput({}), /question is required/);
  assert.throws(() => parseBtwInput({ question: "   " }), /question is required/);
  assert.throws(() => parseBtwInput({ question: "x".repeat(32_001) }), /32,000/);
  assert.throws(() => parseBtwInput({ question: "ok", extra: true }), /unknown field/);
  assert.throws(() => parseBtwInput("plain"), /must be an object/);
});

test("the side-question reminder forbids tools and history side effects", () => {
  const text = btwSystemReminder().text;
  assert.match(text, /side question/);
  assert.match(text, /no tools/);
  assert.match(text, /added to the conversation history/);
});
