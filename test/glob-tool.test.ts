import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPermissionOnlyRipgrepStderr } from "../src/grep-tool.js";
import { executeGlob, GLOB_TOOL, parseGlobInput } from "../src/glob-tool.js";

const signal = () => new AbortController().signal;

async function fixture(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "amber-glob-")));
}

test("defines the Glob tool and parses its input with defaults", () => {
  assert.equal(GLOB_TOOL.name, "Glob");
  assert.deepEqual(Object.keys(GLOB_TOOL.input_schema.properties ?? {}), ["pattern", "path"]);
  assert.deepEqual(GLOB_TOOL.input_schema.required, ["pattern"]);
  assert.deepEqual(parseGlobInput({ pattern: "**/*.js" }), { pattern: "**/*.js" });
  assert.deepEqual(parseGlobInput({ pattern: "*.ts", path: "src" }), { pattern: "*.ts", path: "src" });
  assert.equal(parseGlobInput({ pattern: "*.ts", path: "   " }).path, undefined);
  assert.throws(() => parseGlobInput({}), /non-empty pattern/);
  assert.throws(() => parseGlobInput({ pattern: "" }), /non-empty pattern/);
  assert.throws(() => parseGlobInput({ pattern: 7 }), /non-empty pattern/);
  assert.throws(() => parseGlobInput({ pattern: "x", path: 7 }), /path must be a string/);
});

test("lists matching files newest first", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "older.txt"), "one\n");
  await writeFile(join(directory, "newer.txt"), "two\n");
  await writeFile(join(directory, "other.md"), "three\n");
  const base = Date.now() / 1000 - 1_000;
  await utimes(join(directory, "older.txt"), base - 100, base - 100);
  await utimes(join(directory, "newer.txt"), base, base);
  const result = await executeGlob(parseGlobInput({ pattern: "*.txt" }), [directory], directory, signal());
  assert.equal(result.resultText, "newer.txt\nolder.txt");
  assert.equal(result.output, result.resultText);
  assert.equal(result.workingDirectory, directory);
});

test("recursive patterns descend into subdirectories", async () => {
  const directory = await fixture();
  await mkdir(join(directory, "sub"));
  await writeFile(join(directory, "top.ts"), "top\n");
  await writeFile(join(directory, "sub", "nested.ts"), "nested\n");
  await writeFile(join(directory, "skipped.txt"), "skip\n");
  const result = await executeGlob(parseGlobInput({ pattern: "**/*.ts" }), [directory], directory, signal());
  assert.deepEqual(result.resultText.split("\n").sort(), ["sub/nested.ts", "top.ts"]);
});

test("reports no files without matches", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "sample.txt"), "content\n");
  const result = await executeGlob(parseGlobInput({ pattern: "*.rs" }), [directory], directory, signal());
  assert.equal(result.resultText, "No files found");
});

test("truncates results at 100 files with a note", async () => {
  const directory = await fixture();
  for (let index = 0; index < 105; index += 1) {
    await writeFile(join(directory, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
  }
  const result = await executeGlob(parseGlobInput({ pattern: "*.txt" }), [directory], directory, signal());
  const lines = result.resultText.split("\n");
  assert.equal(lines.length, 101);
  assert.equal(new Set(lines.slice(0, 100)).size, 100);
  assert.match(lines[100] ?? "", /Results are truncated/);
});

test("resolves relative and absolute search paths and rejects invalid ones", async () => {
  const directory = await fixture();
  await mkdir(join(directory, "sub"));
  await writeFile(join(directory, "sub", "file.txt"), "content\n");
  const relative = await executeGlob(
    parseGlobInput({ pattern: "*.txt", path: "sub" }),
    [directory], directory, signal(),
  );
  assert.equal(relative.resultText, "sub/file.txt");
  const absolute = await executeGlob(
    parseGlobInput({ pattern: "*.txt", path: join(directory, "sub") }),
    [directory], directory, signal(),
  );
  assert.equal(absolute.resultText, "sub/file.txt");
  await assert.rejects(
    executeGlob(parseGlobInput({ pattern: "*.txt", path: "missing" }), [directory], directory, signal()),
    /Path does not exist: missing/,
  );
  await assert.rejects(
    executeGlob(parseGlobInput({ pattern: "*.txt", path: "sub/file.txt" }), [directory], directory, signal()),
    /not a directory/,
  );
  await assert.rejects(
    executeGlob(parseGlobInput({ pattern: "*.txt", path: tmpdir() }), [directory], directory, signal()),
    /outside the project and added directories/,
  );
});

test("includes hidden files but excludes version control directories", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".hidden.txt"), "hidden\n");
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, ".git", "config.txt"), "git\n");
  const result = await executeGlob(parseGlobInput({ pattern: "**/*.txt" }), [directory], directory, signal());
  const paths = result.resultText.split("\n");
  assert.ok(paths.includes(".hidden.txt"));
  assert.ok(!paths.some((path) => path.includes(".git")));
});

test("an aborted signal rejects the search", async () => {
  const directory = await fixture();
  await assert.rejects(
    executeGlob(parseGlobInput({ pattern: "*.txt" }), [directory], directory, AbortSignal.abort()),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("classifies permission-only ripgrep stderr", () => {
  assert.equal(isPermissionOnlyRipgrepStderr(""), false);
  assert.equal(isPermissionOnlyRipgrepStderr("   \n"), false);
  assert.equal(
    isPermissionOnlyRipgrepStderr("rg: /tmp/systemd-private-x: Permission denied (os error 13)"),
    true,
  );
  assert.equal(
    isPermissionOnlyRipgrepStderr([
      "rg: /tmp/a: Permission denied (os error 13)",
      "rg: /tmp/b: Permission denied (os error 13)",
    ].join("\n")),
    true,
  );
  assert.equal(isPermissionOnlyRipgrepStderr("rg: error parsing glob"), false);
  assert.equal(
    isPermissionOnlyRipgrepStderr("rg: /tmp/a: Permission denied (os error 13)\nrg: error parsing glob"),
    false,
  );
});

test("returns readable matches when a subdirectory is unreadable", async () => {
  const directory = await fixture();
  const locked = join(directory, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "secret.txt"), "hidden\n");
  await writeFile(join(directory, "visible.txt"), "ok\n");
  await chmod(locked, 0);
  try {
    const result = await executeGlob(parseGlobInput({ pattern: "**/*.txt" }), [directory], directory, signal());
    const paths = result.resultText.split("\n");
    assert.ok(paths.includes("visible.txt"), result.resultText);
    assert.ok(!paths.some((path) => path.includes("secret.txt") || path.includes("locked")), result.resultText);
    assert.doesNotMatch(result.resultText, /ripgrep failed/);
  } finally {
    await chmod(locked, 0o700);
  }
});
