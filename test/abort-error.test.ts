import test from "node:test";
import assert from "node:assert/strict";
import { abortError, throwIfAborted } from "../src/abort-error.js";

test("abortError produces an Error named AbortError carrying the message", () => {
  const error = abortError("boom");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "boom");
});

test("throwIfAborted passes through without a signal", () => {
  assert.doesNotThrow(() => throwIfAborted(undefined, "stop"));
});

test("throwIfAborted passes through when the signal is not aborted", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal, "stop"));
});

test("throwIfAborted throws an AbortError with the message when aborted", () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(
    () => throwIfAborted(controller.signal, "stop"),
    (error: unknown) => {
      const candidate = error as Error;
      return candidate.name === "AbortError" && candidate.message === "stop";
    },
  );
});
