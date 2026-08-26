import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeDirectories, completeDirectoryRoots, completeFiles } from "../src/directory-completion.js";

test("completes relative and absolute directory fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "amber-complete-"));
  await Promise.all([
    mkdir(join(root, "alpha")),
    mkdir(join(root, "alpine")),
    mkdir(join(root, "beta")),
    mkdir(join(root, ".hidden")),
    writeFile(join(root, "also-a-file"), "text"),
  ]);

  assert.deepEqual(
    (await completeDirectories("al", root)).map((entry) => entry.value),
    ["alpha", "alpine"],
  );
  assert.deepEqual(
    (await completeDirectories(`${root}/b`, root)).map((entry) => entry.value),
    [`${root}/beta`],
  );
});

test("completes available working roots for empty cwd fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "amber-complete-roots-"));
  const added = join(root, "added");
  await mkdir(added);
  const missing = join(root, "missing");

  assert.deepEqual(await completeDirectoryRoots([root, added, missing, added]), [
    { value: await realpath(root), absolutePath: await realpath(root) },
    { value: await realpath(added), absolutePath: await realpath(added) },
  ]);
});

test("restricts cwd completion to authorized roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "amber-complete-root-"));
  const current = join(root, "current");
  await mkdir(current);
  await mkdir(join(root, "sibling"));

  assert.deepEqual(
    (await completeDirectories("../s", current, [root])).map((entry) => entry.value),
    ["../sibling"],
  );
  assert.deepEqual(await completeDirectories("../../", current, [root]), []);
});

test("completes file references with navigable directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "amber-file-complete-"));
  await Promise.all([
    mkdir(join(root, "src")),
    writeFile(join(root, "server.ts"), "text"),
    writeFile(join(root, "settings.ts"), "text"),
    writeFile(join(root, ".secret"), "text"),
  ]);

  assert.deepEqual(
    (await completeFiles("s", root, [root])).map(({ value, kind }) => ({ value, kind })),
    [
      { value: "server.ts", kind: "file" },
      { value: "settings.ts", kind: "file" },
      { value: "src/", kind: "directory" },
    ],
  );
  assert.deepEqual((await completeFiles(".", root, [root])).map((entry) => entry.value), [".secret"]);
  assert.deepEqual(await completeFiles("../", root, [root]), []);
});
