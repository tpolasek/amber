import test from "node:test";
import assert from "node:assert/strict";
import { readServerSentEvents } from "../src/sse.js";

async function eventsFrom(chunks: string[], asResponse = false): Promise<{ event: string; data: string }[]> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const source = asResponse ? new Response(stream) : stream;
  const events: { event: string; data: string }[] = [];
  for await (const event of readServerSentEvents(source)) events.push(event);
  return events;
}

test("parses event frames split across chunk boundaries", async () => {
  const events = await eventsFrom(["event: message\nda", "ta: {\"a\":1}\n\nevent: ", "done\ndata: {}\n\n"]);
  assert.deepEqual(events, [
    { event: "message", data: '{"a":1}' },
    { event: "done", data: "{}" },
  ]);
});

test("defaults the event name to message", async () => {
  const events = await eventsFrom(["data: hello\n\n"]);
  assert.deepEqual(events, [{ event: "message", data: "hello" }]);
});

test("joins multi-line data payloads with newlines", async () => {
  const events = await eventsFrom(["event: message\ndata: one\ndata: two\n\n"]);
  assert.deepEqual(events, [{ event: "message", data: "one\ntwo" }]);
});

test("normalizes CRLF line endings", async () => {
  const events = await eventsFrom(["event: done\r\ndata: {}\r\n\r\n"]);
  assert.deepEqual(events, [{ event: "done", data: "{}" }]);
});

test("delivers a final frame without a trailing separator", async () => {
  const events = await eventsFrom(["event: done\ndata: {}\n\n"]);
  assert.equal(events.length, 1);
  const tail = await eventsFrom(["data: end"]);
  assert.deepEqual(tail, [{ event: "message", data: "end" }]);
});

test("skips frames without data", async () => {
  const events = await eventsFrom(["event: ping\n\n", "data: kept\n\n"]);
  assert.deepEqual(events, [{ event: "message", data: "kept" }]);
});

test("accepts a Response the same as a raw stream", async () => {
  assert.deepEqual(await eventsFrom(["data: x\n\n"], true), [{ event: "message", data: "x" }]);
});
