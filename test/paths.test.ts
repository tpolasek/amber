import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isWithinDirectory,
  joinHome,
  resolveSearchPath,
  toRelativePath,
} from "../src/paths.js";

function makeTempDir(t: TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "amber-paths-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("isWithinDirectory accepts the directory itself and its children", () => {
  assert.equal(isWithinDirectory("/a/b", "/a/b"), true);
  assert.equal(isWithinDirectory("/a/b/c", "/a/b"), true);
  assert.equal(isWithinDirectory("/a/b/c/d", "/a/b"), true);
});

test("isWithinDirectory rejects siblings and parent escapes", () => {
  assert.equal(isWithinDirectory("/a/x", "/a/b"), false);
  assert.equal(isWithinDirectory("/a", "/a/b"), false);
  assert.equal(isWithinDirectory("/a/b/../x", "/a/b"), false);
});

test("isWithinDirectory rejects a path that shares a prefix but not a directory boundary", () => {
  assert.equal(isWithinDirectory("/a/bc", "/a/b"), false);
  assert.equal(isWithinDirectory("/a/bc/d", "/a/b"), false);
});

test("isWithinDirectory does not leak absolute Windows-style paths", () => {
  assert.equal(isWithinDirectory("C:\\Users\\secret", "/a/b"), false);
  assert.equal(isWithinDirectory("C:/Users/secret", "/a/b"), false);
});

test("joinHome expands ~ and ~/sub against the home directory", () => {
  const home = homedir();
  assert.equal(joinHome("~"), home);
  assert.equal(joinHome("~/sub"), resolve(home, "sub"));
  assert.equal(joinHome("~/a/b"), resolve(home, "a", "b"));
});

test("toRelativePath renders children relative and the directory itself as dot", () => {
  assert.equal(toRelativePath("/a/b/c", "/a/b"), "c");
  assert.equal(toRelativePath("/a/b/c/d", "/a/b"), join("c", "d"));
  assert.equal(toRelativePath("/a/b", "/a/b"), ".");
});

test("toRelativePath falls back to the absolute input when the path is outside", () => {
  assert.equal(toRelativePath("/a/x", "/a/b"), "/a/x");
  assert.equal(toRelativePath("/a/bc", "/a/b"), "/a/bc");
});

test("toRelativePath does not leak absolute Windows-style paths", () => {
  assert.equal(toRelativePath("C:\\Users\\secret", "/a/b"), "C:\\Users\\secret");
});

test("resolveSearchPath resolves a relative path against the current directory", async (t) => {
  const root = makeTempDir(t);
  mkdirSync(join(root, "sub"));

  assert.equal(await resolveSearchPath("sub", [root], root), join(root, "sub"));
});

test("resolveSearchPath resolves an absolute path", async (t) => {
  const root = makeTempDir(t);
  mkdirSync(join(root, "sub"));

  assert.equal(await resolveSearchPath(join(root, "sub"), [root], root), join(root, "sub"));
});

test("resolveSearchPath defaults to the current directory when requested is undefined", async (t) => {
  const root = makeTempDir(t);

  assert.equal(await resolveSearchPath(undefined, [root], root), root);
});

test("resolveSearchPath throws for a nonexistent path", async (t) => {
  const root = makeTempDir(t);

  await assert.rejects(resolveSearchPath("missing", [root], root), /Path does not exist: missing/);
});

test("resolveSearchPath rejects a path outside the allowed directories", async (t) => {
  const root = makeTempDir(t);
  const outside = makeTempDir(t);
  mkdirSync(join(outside, "sub"));

  await assert.rejects(
    resolveSearchPath(join(outside, "sub"), [root], root),
    /outside the project and added directories/,
  );
});

test("resolveSearchPath expands a ~-relative path against HOME", async (t) => {
  const root = makeTempDir(t);
  const home = join(root, "home");
  mkdirSync(join(home, "sub"), { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  assert.equal(await resolveSearchPath("~/sub", [root], root), join(home, "sub"));
});
