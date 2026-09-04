import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserInstructions, userInstructionsPath } from "../src/user-instructions.js";

async function amberHome(): Promise<string> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-instructions-"));
  await mkdir(join(homeDirectory, ".amber"), { recursive: true });
  return homeDirectory;
}

test("reports no instructions when the file does not exist", async () => {
  const homeDirectory = await amberHome();

  assert.deepEqual(await loadUserInstructions(homeDirectory), {});
});

test("reports no instructions when the .amber directory does not exist", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-instructions-"));

  assert.deepEqual(await loadUserInstructions(homeDirectory), {});
});

test("reads the instructions from ~/.amber/AGENTS.md", async () => {
  const homeDirectory = await amberHome();
  await writeFile(userInstructionsPath(homeDirectory), "\n# House rules\n\nPrefer plain dashes.\n", "utf8");

  assert.deepEqual(await loadUserInstructions(homeDirectory), {
    text: "# House rules\n\nPrefer plain dashes.",
  });
});

test("reports an empty instructions file as a problem", async () => {
  const homeDirectory = await amberHome();
  await writeFile(userInstructionsPath(homeDirectory), "   \n\n", "utf8");
  const path = userInstructionsPath(homeDirectory);

  const loaded = await loadUserInstructions(homeDirectory);

  assert.equal(loaded.text, undefined);
  assert.equal(loaded.problem, `${path} is empty, so no user instructions were loaded.`);
});

test("reports an unreadable instructions file without a stack trace", async () => {
  const homeDirectory = await amberHome();
  const path = userInstructionsPath(homeDirectory);
  await writeFile(path, "# House rules\n", "utf8");
  await chmod(path, 0o000);
  if (process.getuid?.() === 0) return; // root ignores the mode, so the read still succeeds.

  const loaded = await loadUserInstructions(homeDirectory);

  assert.equal(loaded.text, undefined);
  assert.match(loaded.problem ?? "", new RegExp(`^Could not read ${path}: `));
  assert.doesNotMatch(loaded.problem ?? "", /\n\s+at /);
});

test("reports a directory in place of the instructions file as a problem", async () => {
  const homeDirectory = await amberHome();
  await mkdir(userInstructionsPath(homeDirectory));

  const loaded = await loadUserInstructions(homeDirectory);

  assert.equal(loaded.text, undefined);
  assert.match(loaded.problem ?? "", /^Could not read /);
});
