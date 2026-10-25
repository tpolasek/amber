// test/cli-blocks.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createBlockSplitter } from "../src/cli/blocks.js";

test("closes a paragraph at a blank line and holds the tail", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("para one\n\npar"), ["para one"]);
  assert.equal(splitter.finish(), "par");
});

test("splits mid-word deltas without closing early", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("he"), []);
  assert.deepEqual(splitter.push("llo\n\n"), ["hello"]);
  assert.equal(splitter.finish(), "");
});

test("keeps fenced code open until the closing fence", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("```js\nconst x = 1;\nconst y"), []);
  assert.deepEqual(splitter.push(" = 2;\n```\nafter"), ["```js\nconst x = 1;\nconst y = 2;\n```"]);
  assert.equal(splitter.finish(), "after");
});

test("a fence line closes the pending paragraph before opening the fence", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("intro\n```"), ["intro"]);
  assert.deepEqual(splitter.push("\ncode\n```"), ["```\ncode\n```"]);
});

test("tilde fences and longer closing fences close blocks", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("~~~\ncode\n~~~~~~\ntail"), ["~~~\ncode\n~~~~~~"]);
  assert.equal(splitter.finish(), "tail");
});

test("skips leading and repeated blank lines", () => {
  const splitter = createBlockSplitter();
  assert.deepEqual(splitter.push("\n\n\nfirst\n\n\n"), ["first"]);
  assert.deepEqual(splitter.push("\n\nsecond\n\n"), ["second"]);
});

test("finish returns the pending list block at end of message", () => {
  const splitter = createBlockSplitter();
  splitter.push("- one\n- two");
  assert.equal(splitter.finish(), "- one\n- two");
  assert.equal(splitter.finish(), "");
});

test("tables stream as ordinary blank-line-delimited blocks", () => {
  const splitter = createBlockSplitter();
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  assert.deepEqual(splitter.push(`${table}\n\nnext`), [table]);
});

test("incremental and one-shot pushes close the same blocks", () => {
  const oneShot = createBlockSplitter();
  const expected = [...oneShot.push("```js\nconst x = 1;\n```\n\ntail"), oneShot.finish()].filter((block) => block !== "");
  const incremental = createBlockSplitter();
  const got = [
    ...incremental.push("```js\nconst x"),
    ...incremental.push(" = 1;\n```\n\nta"),
    ...incremental.push("il"),
    incremental.finish(),
  ].filter((block) => block !== "");
  assert.deepEqual(got, expected);
});
