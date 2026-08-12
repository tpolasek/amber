import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeDirectories } from "../src/directory-completion.js";

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
