import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGrep, GREP_TOOL, parseGrepInput } from "../src/grep-tool.js";

const signal = () => new AbortController().signal;

async function fixture(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "amber-grep-")));
}

test("defines the Grep tool and parses its input with defaults", () => {
  assert.equal(GREP_TOOL.name, "Grep");
  assert.deepEqual(Object.keys(GREP_TOOL.input_schema.properties ?? {}), [
    "pattern", "path", "glob", "output_mode", "-B", "-A", "-C", "context", "-n", "-i", "type", "head_limit", "offset", "multiline",
  ]);
  assert.deepEqual(parseGrepInput({ pattern: "needle" }), {
    pattern: "needle",
    outputMode: "files_with_matches",
    showLineNumbers: true,
    caseInsensitive: false,
    multiline: false,
    offset: 0,
  });
  assert.deepEqual(parseGrepInput({
    pattern: "needle",
    path: "src",
    glob: "*.ts",
    type: "ts",
    output_mode: "content",
    "-B": 1,
    "-A": 2,
    "-C": 3,
    "-n": false,
    "-i": true,
    multiline: true,
    head_limit: 10,
    offset: 4,
  }), {
    pattern: "needle",
    outputMode: "content",
    showLineNumbers: false,
    caseInsensitive: true,
    multiline: true,
    offset: 4,
    headLimit: 10,
    path: "src",
    glob: "*.ts",
    type: "ts",
    contextBefore: 1,
    contextAfter: 2,
    context: 3,
  });
  assert.equal(parseGrepInput({ pattern: "x", "-C": 2 }).context, 2);
  assert.equal(parseGrepInput({ pattern: "x", context: 5, "-C": 2 }).context, 5);
  assert.deepEqual(parseGrepInput({ pattern: "x", head_limit: "3", offset: "6", "-A": "1", "-i": "true", "-n": "false" }), {
    pattern: "x",
    outputMode: "files_with_matches",
    showLineNumbers: false,
    caseInsensitive: true,
    multiline: false,
    offset: 6,
    headLimit: 3,
    contextAfter: 1,
  });
  assert.throws(() => parseGrepInput({ pattern: "", }), /non-empty pattern/);
  assert.throws(() => parseGrepInput({}), /non-empty pattern/);
  assert.throws(() => parseGrepInput({ pattern: "x", output_mode: "bogus" }), /output_mode/);
  assert.throws(() => parseGrepInput({ pattern: "x", head_limit: -1 }), /head_limit/);
  assert.throws(() => parseGrepInput({ pattern: "x", offset: 1.5 }), /offset/);
  assert.throws(() => parseGrepInput({ pattern: "x", "-i": "yes" }), /-i must be a boolean/);
  assert.throws(() => parseGrepInput({ pattern: "x", path: 7 }), /path must be a string/);
});

test("files_with_matches lists matching files newest first", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "older.txt"), "needle here\n");
  await writeFile(join(directory, "newer.txt"), "needle there\n");
  await writeFile(join(directory, "other.txt"), "nothing relevant\n");
  const base = Date.now() / 1000 - 1_000;
  await utimes(join(directory, "older.txt"), base - 100, base - 100);
  await utimes(join(directory, "newer.txt"), base, base);
  const result = await executeGrep(parseGrepInput({ pattern: "needle" }), [directory], directory, signal());
  assert.equal(result.resultText, "Found 2 files\nnewer.txt\nolder.txt");
  assert.equal(result.output, result.resultText);
  assert.equal(result.workingDirectory, directory);
});

test("files_with_matches reports no files without matches", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "empty.txt"), "nothing\n");
  const result = await executeGrep(parseGrepInput({ pattern: "needle" }), [directory], directory, signal());
  assert.equal(result.resultText, "No files found");
});

test("content mode shows line numbers, context, and relative paths", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "sample.txt"), "alpha\nbeta\nGAMMA\ndelta\n");
  const exact = await executeGrep(
    parseGrepInput({ pattern: "GAMMA", output_mode: "content" }),
    [directory], directory, signal(),
  );
  assert.equal(exact.resultText, "sample.txt:3:GAMMA");
  const contextual = await executeGrep(
    parseGrepInput({ pattern: "GAMMA", output_mode: "content", "-C": 1 }),
    [directory], directory, signal(),
  );
  assert.equal(contextual.resultText, "sample.txt-2-beta\nsample.txt:3:GAMMA\nsample.txt-4-delta");
  const caseInsensitive = await executeGrep(
    parseGrepInput({ pattern: "gamma", output_mode: "content", "-i": true }),
    [directory], directory, signal(),
  );
  assert.equal(caseInsensitive.resultText, "sample.txt:3:GAMMA");
});

test("single-file searches omit the path prefix", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "sample.txt"), "alpha\nbeta\nGAMMA\n");
  const result = await executeGrep(
    parseGrepInput({ pattern: "GAMMA", output_mode: "content", path: "sample.txt" }),
    [directory], directory, signal(),
  );
  assert.equal(result.resultText, "3:GAMMA");
});

test("glob and type filters restrict the search", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "keep.ts"), "hit\n");
  await writeFile(join(directory, "skip.md"), "hit\n");
  await writeFile(join(directory, "skip.txt"), "hit\n");
  const base = Date.now() / 1000 - 1_000;
  await utimes(join(directory, "keep.ts"), base, base);
  await utimes(join(directory, "skip.md"), base - 100, base - 100);
  await utimes(join(directory, "skip.txt"), base - 200, base - 200);
  const glob = await executeGrep(
    parseGrepInput({ pattern: "hit", glob: "*.ts" }),
    [directory], directory, signal(),
  );
  assert.equal(glob.resultText, "Found 1 file\nkeep.ts");
  const braceGlob = await executeGrep(
    parseGrepInput({ pattern: "hit", glob: "*.{ts,md}" }),
    [directory], directory, signal(),
  );
  assert.equal(braceGlob.resultText, "Found 2 files\nkeep.ts\nskip.md");
  const type = await executeGrep(
    parseGrepInput({ pattern: "hit", type: "ts" }),
    [directory], directory, signal(),
  );
  assert.equal(type.resultText, "Found 1 file\nkeep.ts");
});

test("count mode reports per-file counts and totals", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "one.txt"), "hit\nhit\nmiss\n");
  await writeFile(join(directory, "two.txt"), "hit\n");
  const result = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "count" }),
    [directory], directory, signal(),
  );
  assert.match(result.resultText, /one\.txt:2/);
  assert.match(result.resultText, /two\.txt:1/);
  assert.match(result.resultText, /Found 3 total occurrences across 2 files\.$/);
  const single = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "count" }),
    [join(directory, "one.txt")], join(directory, "one.txt"), signal(),
  );
  assert.equal(single.resultText, "2\n\nFound 2 total occurrences across 1 file.");
});

test("head_limit and offset paginate content and file results", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "lines.txt"), "hit 1\nhit 2\nhit 3\nhit 4\nhit 5\n");
  const limited = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content", head_limit: 2 }),
    [directory], directory, signal(),
  );
  assert.equal(
    limited.resultText,
    "lines.txt:1:hit 1\nlines.txt:2:hit 2\n\n[Showing results with pagination = limit: 2]",
  );
  const paged = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content", head_limit: 2, offset: 2 }),
    [directory], directory, signal(),
  );
  assert.equal(
    paged.resultText,
    "lines.txt:3:hit 3\nlines.txt:4:hit 4\n\n[Showing results with pagination = limit: 2, offset: 2]",
  );
  const tail = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content", head_limit: 2, offset: 4 }),
    [directory], directory, signal(),
  );
  assert.equal(tail.resultText, "lines.txt:5:hit 5\n\n[Showing results with pagination = offset: 4]");
  const beyond = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content", head_limit: 2, offset: 10 }),
    [directory], directory, signal(),
  );
  assert.equal(beyond.resultText, "No matches found");

  const base = Date.now() / 1000 - 1_000;
  await utimes(join(directory, "lines.txt"), base - 10, base - 10);
  for (const [index, name] of ["first.txt", "second.txt", "third.txt"].entries()) {
    await writeFile(join(directory, name), "hit\n");
    await utimes(join(directory, name), base - index, base - index);
  }
  const truncated = await executeGrep(
    parseGrepInput({ pattern: "hit", head_limit: 2 }),
    [directory], directory, signal(),
  );
  assert.equal(truncated.resultText, "Found 2 files limit: 2\nfirst.txt\nsecond.txt");
});

test("the default head limit is 250 and head_limit 0 is unlimited", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "lines.txt"), `${Array.from({ length: 260 }, (_, i) => `hit ${i + 1}`).join("\n")}\n`);
  const limited = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content" }),
    [directory], directory, signal(),
  );
  assert.equal(limited.resultText.split("\n").length, 252);
  assert.match(limited.resultText, /\[Showing results with pagination = limit: 250\]$/);
  const unlimited = await executeGrep(
    parseGrepInput({ pattern: "hit", output_mode: "content", head_limit: 0 }),
    [directory], directory, signal(),
  );
  assert.equal(unlimited.resultText.split("\n").length, 260);
  assert.doesNotMatch(unlimited.resultText, /pagination/);
});

test("resolves relative paths and rejects missing or unauthorized paths", async () => {
  const directory = await fixture();
  await mkdir(join(directory, "sub"));
  await writeFile(join(directory, "sub", "file.txt"), "needle\n");
  const relative = await executeGrep(
    parseGrepInput({ pattern: "needle", path: "sub" }),
    [directory], directory, signal(),
  );
  assert.equal(relative.resultText, "Found 1 file\nsub/file.txt");
  const absolute = await executeGrep(
    parseGrepInput({ pattern: "needle", path: join(directory, "sub") }),
    [directory], directory, signal(),
  );
  assert.equal(absolute.resultText, "Found 1 file\nsub/file.txt");
  await assert.rejects(
    executeGrep(parseGrepInput({ pattern: "needle", path: "missing" }), [directory], directory, signal()),
    /Path does not exist: missing/,
  );
  await assert.rejects(
    executeGrep(parseGrepInput({ pattern: "needle", path: tmpdir() }), [directory], directory, signal()),
    /outside the project and added directories/,
  );
});

test("multiline patterns span lines only with multiline enabled", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "span.txt"), "start\nend\n");
  await assert.rejects(
    executeGrep(parseGrepInput({ pattern: "start\\nend", output_mode: "content" }), [directory], directory, signal()),
    /multiline/,
  );
  const multiline = await executeGrep(
    parseGrepInput({ pattern: "start\\nend", output_mode: "content", multiline: true }),
    [directory], directory, signal(),
  );
  assert.match(multiline.resultText, /span\.txt:1:start/);
});

test("an aborted signal rejects the search", async () => {
  const directory = await fixture();
  await assert.rejects(
    executeGrep(parseGrepInput({ pattern: "needle" }), [directory], directory, AbortSignal.abort()),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
