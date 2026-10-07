import test from "node:test";
import assert from "node:assert/strict";
import ignoreFactory from "../src/ignore.js";

test("matches plain names at any depth", () => {
  const ig = ignoreFactory().add("node_modules");
  assert.equal(ig.ignores("node_modules"), true);
  assert.equal(ig.ignores("src/node_modules"), true);
  assert.equal(ig.ignores("src/main.ts"), false);
});

test("anchored patterns only match from the root", () => {
  const ig = ignoreFactory().add("/dist");
  assert.equal(ig.ignores("dist"), true);
  assert.equal(ig.ignores("src/dist"), false);
});

test("directory patterns match everything inside", () => {
  const ig = ignoreFactory().add("build/");
  assert.equal(ig.ignores("build/"), true);
  assert.equal(ig.ignores("build/output.js"), true);
  assert.equal(ig.ignores("src/build"), false);
});

test("later negation rules unignore earlier matches", () => {
  const ig = ignoreFactory().add(["*.log", "!keep.log"]);
  assert.equal(ig.ignores("debug.log"), true);
  assert.equal(ig.ignores("keep.log"), false);
});

test("a file under an ignored directory stays ignored even if negated", () => {
  const ig = ignoreFactory().add(["logs/", "!logs/keep.txt"]);
  assert.equal(ig.ignores("logs/keep.txt"), true);
});

test("globs with * stay within one directory", () => {
  const ig = ignoreFactory().add("src/*.ts");
  assert.equal(ig.ignores("src/main.ts"), true);
  assert.equal(ig.ignores("src/lib/util.ts"), false);
});

test("double globstars cross directories", () => {
  const ig = ignoreFactory().add("**/*.snap");
  assert.equal(ig.ignores("a.snap"), true);
  assert.equal(ig.ignores("deep/nested/a.snap"), true);
});

test("intermediate globstars match zero or more directories", () => {
  const ig = ignoreFactory().add("src/**/generated");
  assert.equal(ig.ignores("src/generated"), true);
  assert.equal(ig.ignores("src/a/b/generated"), true);
  assert.equal(ig.ignores("lib/generated"), false);
});

test("character classes match members", () => {
  const ig = ignoreFactory().add("*.t[sx]");
  assert.equal(ig.ignores("main.ts"), true);
  assert.equal(ig.ignores("main.tsx"), false);
  assert.equal(ig.ignores("main.ty"), false);
});

test("ignores case-insensitively by default and honors ignoreCase: false", () => {
  assert.equal(ignoreFactory().add("readme.md").ignores("README.md"), true);
  assert.equal(ignoreFactory({ ignoreCase: false }).add("readme.md").ignores("README.md"), false);
});

test("comment and blank lines are skipped", () => {
  const ig = ignoreFactory().add("# a comment\n\nreal.txt\n");
  assert.equal(ig.ignores("real.txt"), true);
  assert.equal(ig.ignores("# a comment"), false);
});

test("escaped hash or bang is a literal pattern", () => {
  const ig = ignoreFactory().add("\\#literal");
  assert.equal(ig.ignores("#literal"), true);
});

test("rejects invalid paths", () => {
  const ig = ignoreFactory();
  assert.throws(() => ig.ignores(".."), RangeError);
  assert.throws(() => ig.ignores(""), TypeError);
  assert.throws(() => ig.ignores("/absolute"), RangeError);
});

test("allows relative paths when allowRelativePaths is set", () => {
  const ig = ignoreFactory({ allowRelativePaths: true }).add("tmp");
  assert.equal(ig.ignores("../tmp"), true);
  assert.doesNotThrow(() => ig.ignores("../outside"));
});

test("re-adding rules resets cached results", () => {
  const ig = ignoreFactory().add("a.txt");
  assert.equal(ig.ignores("a.txt"), true);
  ig.add("b.txt");
  assert.equal(ig.ignores("b.txt"), true);
  assert.equal(ig.ignores("a.txt"), true);
});
