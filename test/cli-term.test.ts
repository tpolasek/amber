// test/cli-term.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "../src/cli/term.js";
import { DARK, LIGHT } from "../src/cli/theme.js";

interface FakeOut {
  write: (chunk: string) => boolean;
  isTTY: boolean;
  columns: number;
  chunks: string[];
}

function fakeOut(isTTY = true): FakeOut {
  return {
    chunks: [],
    write(chunk: string) { this.chunks.push(chunk); return true; },
    isTTY,
    columns: 80,
  };
}

function terminal(out: FakeOut): Terminal {
  delete process.env.NO_COLOR;
  return new Terminal(out, 60_000, 4096);
}

test("batches lines until flush", () => {
  const out = fakeOut();
  const term = terminal(out);
  term.line("hello");
  assert.deepEqual(out.chunks, []);
  term.flush();
  assert.deepEqual(out.chunks, ["hello\n"]);
});

test("flushes immediately when the buffer exceeds maxBufferBytes", () => {
  const out = fakeOut();
  const term = terminal(out);
  term.append("x".repeat(4096));
  assert.equal(out.chunks.length, 1);
});

test("status line rewrites itself and yields to content", () => {
  const out = fakeOut();
  const term = terminal(out);
  term.line("one");
  term.status("working");
  term.status("still working");
  term.line("two");
  term.flush();
  term.end();
  assert.deepEqual(out.chunks, [
    "one\n",
    "\r\x1b[Kworking",
    "\r\x1b[Kstill working",
    "\r\x1b[K",
    "two\n",
    "\r\x1b[Kstill working",
    "\r\x1b[K",
  ]);
});

test("suppressStatus clears an active status line once", () => {
  const out = fakeOut();
  const term = terminal(out);
  term.status("busy");
  term.suppressStatus();
  term.suppressStatus();
  assert.deepEqual(out.chunks, ["\r\x1b[Kbusy", "\r\x1b[K"]);
});

test("status is a no-op without a TTY", () => {
  const out = fakeOut(false);
  const term = terminal(out);
  term.status("busy");
  assert.deepEqual(out.chunks, []);
});

test("style strips codes when NO_COLOR is set or output is not a TTY", () => {
  const color = terminal(fakeOut());
  assert.equal(color.style("x", "1"), "\x1b[1mx\x1b[0m");
  process.env.NO_COLOR = "1";
  assert.equal(new Terminal(fakeOut()).style("x", "1"), "x");
  delete process.env.NO_COLOR;
  assert.equal(new Terminal(fakeOut(false)).style("x", "1"), "x");
});

test("columns falls back to 80", () => {
  const out = fakeOut();
  out.columns = 0;
  assert.equal(new Terminal(out).columns, 80);
});

test("runs merges styled runs and strips codes without color", () => {
  const term = terminal(fakeOut());
  assert.equal(
    term.runs([{ text: "a", codes: "1" }, { text: "b", codes: "1" }, { text: "c" }]),
    "\x1b[1mab\x1b[0mc",
  );
  process.env.NO_COLOR = "1";
  assert.equal(new Terminal(fakeOut()).runs([{ text: "a", codes: "1" }]), "a");
  delete process.env.NO_COLOR;
});

test("the terminal defaults to the dark theme and accepts an override", () => {
  assert.equal(terminal(fakeOut()).theme, DARK);
  assert.equal(new Terminal(fakeOut(), undefined, undefined, LIGHT).theme, LIGHT);
});

test("eraseLine flushes pending content then clears the line on a TTY", () => {
  const out = fakeOut();
  const term = terminal(out);
  term.line("x");
  term.eraseLine();
  assert.deepEqual(out.chunks, ["x\n", "\r\x1b[K"]);
});

test("eraseLine is a no-op without a TTY", () => {
  const out = fakeOut(false);
  const term = new Terminal(out);
  term.line("x");
  term.eraseLine();
  assert.deepEqual(out.chunks, []);
});
