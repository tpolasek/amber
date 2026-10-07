import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/shell-quote.js";

test("splits unquoted arguments on whitespace", () => {
  assert.deepEqual(parse("ls -la src"), ["ls", "-la", "src"]);
});

test("preserves quoted runs as single arguments", () => {
  assert.deepEqual(parse("echo 'hello world'"), ["echo", "hello world"]);
  assert.deepEqual(parse('echo "two  spaces"'), ["echo", "two  spaces"]);
});

test("honors backslash escapes", () => {
  assert.deepEqual(parse("echo a\\ b"), ["echo", "a b"]);
  assert.deepEqual(parse("echo \\'quoted\\'"), ["echo", "'quoted'"]);
});

test("expands $variables from the environment", () => {
  assert.deepEqual(parse("echo $NAME", { NAME: "amber" }), ["echo", "amber"]);
  assert.deepEqual(parse("echo ${NAME}", { NAME: "amber" }), ["echo", "amber"]);
});

test("leaves undefined variables empty", () => {
  assert.deepEqual(parse("echo $MISSING", {}), ["echo", ""]);
});

test("marks glob patterns", () => {
  assert.deepEqual(parse("cat *.ts"), ["cat", { op: "glob", pattern: "*.ts" }]);
});

test("reports control operators", () => {
  assert.deepEqual(parse("a && b"), ["a", { op: "&&" }, "b"]);
  assert.deepEqual(parse("a | b"), ["a", { op: "|" }, "b"]);
  assert.deepEqual(parse("a>b"), ["a", { op: ">" }, "b"]);
});

test("captures comments", () => {
  assert.deepEqual(parse("run # note"), ["run", { comment: " note" }]);
});

test("splits expanded variables on the splitUnquoted separator", () => {
  assert.deepEqual(
    parse("echo $ITEMS", { ITEMS: "a,b,c" }, { splitUnquoted: "," }),
    ["echo", "a", "b", "c"],
  );
  assert.deepEqual(
    parse("echo $ITEMS", { ITEMS: "a b" }, { splitUnquoted: true }),
    ["echo", "a", "b"],
  );
});

test("keeps adjacent quotes and text joined", () => {
  assert.deepEqual(parse("pre'post'post"), ["prepostpost"]);
});
