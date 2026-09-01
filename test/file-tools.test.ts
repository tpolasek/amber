import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFileTool, FILE_TOOLS } from "../src/file-tools.js";
import type { Session } from "../src/types.js";

function session(): Session {
  const now = new Date().toISOString();
  return { id: "test.session.name", title: "test", createdAt: now, updatedAt: now, messages: [] };
}

test("exposes text-only Read, Write, and Edit definitions", () => {
  assert.deepEqual(FILE_TOOLS.map((tool) => tool.name), ["Read", "Write", "Edit"]);
  const readProperties = FILE_TOOLS[0]?.input_schema.properties ?? {};
  assert.deepEqual(Object.keys(readProperties), ["file_path", "offset", "limit"]);
  assert.equal("pages" in readProperties, false);
  assert.match(FILE_TOOLS[1]?.description ?? "", /fully read once/);
  assert.doesNotMatch(FILE_TOOLS[1]?.description ?? "", /must not have changed/);
  assert.match(FILE_TOOLS[2]?.description ?? "", /do not repeatedly Read/);
});

test("Read returns numbered lines and records full-read state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
  const canonicalFilePath = await realpath(filePath);
  const current = session();
  const result = await executeFileTool("Read", { file_path: filePath }, [directory], current);

  assert.equal(result.filePath, canonicalFilePath);
  assert.equal(result.output, "     1→first\n     2→second\n     3→third");
  assert.equal(result.resultText, "     1→first\n     2→second\n     3→third");
  assert.deepEqual(result.readRange, { startLine: 1, endLine: 3, totalLines: 3 });
  assert.equal(current.fileReadState?.[canonicalFilePath]?.full, true);

  const partial = await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 1 }, [directory], session());
  assert.equal(partial.output, "     2→second");
  assert.deepEqual(partial.readRange, { startLine: 2, endLine: 2, totalLines: 3 });
});

test("Read deduplicates ranges already present in conversation context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");
  const current = session();

  await executeFileTool("Read", { file_path: filePath, offset: 1, limit: 3 }, [directory], current);
  const cached = await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 2 }, [directory], current);

  assert.equal(cached.output, "Cached Read · reused earlier context");
  assert.deepEqual(cached.readRange, { startLine: 2, endLine: 3, totalLines: 4 });
  assert.match(cached.resultText, /already returned by an earlier Read/);
  assert.doesNotMatch(cached.resultText, /two\n.*three/s);
});

test("adjacent Read ranges combine to deduplicate a later overlapping range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");
  const current = session();

  await executeFileTool("Read", { file_path: filePath, offset: 1, limit: 2 }, [directory], current);
  await executeFileTool("Read", { file_path: filePath, offset: 3, limit: 2 }, [directory], current);
  const cached = await executeFileTool("Read", { file_path: filePath, offset: 1, limit: 4 }, [directory], current);

  assert.equal(cached.output, "Cached Read · reused earlier context");
  await executeFileTool("Write", { file_path: filePath, content: "all covered\n" }, [directory], current);
});

test("Read deduplicates repeated empty and beyond-EOF results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "empty.txt");
  await writeFile(filePath, "", "utf8");
  const current = session();

  await executeFileTool("Read", { file_path: filePath }, [directory], current);
  const emptyCached = await executeFileTool("Read", { file_path: filePath }, [directory], current);
  const beyondCached = await executeFileTool("Read", { file_path: filePath, offset: 100, limit: 2 }, [directory], current);

  assert.equal(emptyCached.output, "Cached Read · reused earlier context");
  assert.equal(beyondCached.output, "Cached Read · reused earlier context");
});

test("partial Read does not authorize an existing-file write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
  const canonicalFilePath = await realpath(filePath);
  const current = session();
  await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 1 }, [directory], current);
  assert.equal(current.fileReadState?.[canonicalFilePath]?.full, false);
  await assert.rejects(
    executeFileTool("Write", { file_path: filePath, content: "replacement\n" }, [directory], current),
    /not been fully read/,
  );
});

test("partial Read authorizes Edit of covered lines but not unread lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\nthird\nfourth\n", "utf8");
  const current = session();
  await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 2 }, [directory], current);

  await assert.rejects(
    executeFileTool("Edit", { file_path: filePath, old_string: "first", new_string: "1st" }, [directory], current),
    /Lines 1-1 of .* have not been read yet/,
  );
  await assert.rejects(
    executeFileTool("Edit", { file_path: filePath, old_string: "third\nfourth", new_string: "3rd\n4th" }, [directory], current),
    /Lines 3-4 of .* have not been read yet/,
  );
  const edited = await executeFileTool(
    "Edit",
    { file_path: filePath, old_string: "second\nthird", new_string: "2nd\n3rd" },
    [directory],
    current,
  );
  assert.match(edited.resultText, /updated successfully/);
  assert.equal(await readFile(filePath, "utf8"), "first\n2nd\n3rd\nfourth\n");
});

test("Edit with replace_all requires every occurrence to sit in read lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "dup\nother\ndup\n", "utf8");
  const current = session();
  await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 1 }, [directory], current);

  await assert.rejects(
    executeFileTool(
      "Edit",
      { file_path: filePath, old_string: "dup", new_string: "twin", replace_all: true },
      [directory],
      current,
    ),
    /Lines 1-1 of .* have not been read yet/,
  );
});

test("Edit rejects a file that was never read or changed since its last partial Read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\n", "utf8");
  const unread = session();
  await assert.rejects(
    executeFileTool("Edit", { file_path: filePath, old_string: "first", new_string: "1st" }, [directory], unread),
    /not been fully read/,
  );

  const stale = session();
  await executeFileTool("Read", { file_path: filePath, offset: 1, limit: 1 }, [directory], stale);
  await writeFile(filePath, "externally changed\nsecond\n", "utf8");
  await assert.rejects(
    executeFileTool("Edit", { file_path: filePath, old_string: "second", new_string: "2nd" }, [directory], stale),
    /not been fully read/,
  );
});

test("Write creates nested files, requires one full read, and resets Read coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "nested", "sample.txt");
  const current = session();
  const created = await executeFileTool("Write", { file_path: filePath, content: "created\n" }, [directory], current);
  assert.match(created.output, /^--- \/dev\/null\n\+\+\+ b\/.*\/nested\/sample\.txt\n@@ -0,0 \+1,1 @@\n\+created$/);
  assert.equal(await readFile(filePath, "utf8"), "created\n");

  await executeFileTool("Write", { file_path: filePath, content: "updated\n" }, [directory], current);
  assert.equal(await readFile(filePath, "utf8"), "updated\n");

  const afterWrite = await executeFileTool("Read", { file_path: filePath }, [directory], current);
  assert.equal(afterWrite.resultText, "     1→updated");
  const cachedAfterWrite = await executeFileTool("Read", { file_path: filePath }, [directory], current);
  assert.equal(cachedAfterWrite.output, "Cached Read · reused earlier context");

  await writeFile(filePath, "external change\n", "utf8");
  await executeFileTool("Write", { file_path: filePath, content: "no concurrency checks\n" }, [directory], current);
  assert.equal(await readFile(filePath, "utf8"), "no concurrency checks\n");
});

test("Edit requires exact uniqueness and preserves CRLF and file mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "script.sh");
  await writeFile(filePath, "one\r\ntwo\r\ntwo\r\n", { encoding: "utf8", mode: 0o755 });
  const current = session();
  await executeFileTool("Read", { file_path: filePath }, [directory], current);

  await assert.rejects(
    executeFileTool("Edit", { file_path: filePath, old_string: "two", new_string: "three" }, [directory], current),
    /Found 2 matches/,
  );
  const edited = await executeFileTool(
    "Edit",
    { file_path: filePath, old_string: "two", new_string: "three", replace_all: true },
    [directory],
    current,
  );
  assert.match(edited.output, /^--- a\/.*\/script\.sh\n\+\+\+ b\/.*\/script\.sh\n@@/);
  assert.match(edited.output, /-two\n-two\n\+three\n\+three/);
  assert.equal(await readFile(filePath, "utf8"), "one\r\nthree\r\nthree\r\n");
  assert.equal((await stat(filePath)).mode & 0o777, 0o755);

  const afterEdit = await executeFileTool("Read", { file_path: filePath }, [directory], current);
  assert.match(afterEdit.resultText, /1→one\n\s+2→three/);
  const cachedAfterEdit = await executeFileTool("Read", { file_path: filePath }, [directory], current);
  assert.equal(cachedAfterEdit.output, "Cached Read · reused earlier context");
});

test("Edit treats replacement dollar sequences as literal text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "route.ts");
  await writeFile(filePath, "const tasks = 1;\nconst after = 2;\n", "utf8");
  const current = session();
  await executeFileTool("Read", { file_path: filePath }, [directory], current);

  await executeFileTool(
    "Edit",
    {
      file_path: filePath,
      old_string: "const tasks = 1;",
      new_string: "const tasks = 1;\nconst git = `/git$`;",
    },
    [directory],
    current,
  );
  assert.equal(await readFile(filePath, "utf8"), "const tasks = 1;\nconst git = `/git$`;\nconst after = 2;\n");

  await executeFileTool("Read", { file_path: filePath }, [directory], current);
  await executeFileTool(
    "Edit",
    {
      file_path: filePath,
      old_string: "const git = `/git$`;",
      new_string: "const git = `/git$'`;\nconst extra = '$&$1';",
      replace_all: true,
    },
    [directory],
    current,
  );
  assert.equal(
    await readFile(filePath, "utf8"),
    "const tasks = 1;\nconst git = `/git$'`;\nconst extra = '$&$1';\nconst after = 2;\n",
  );
});

test("Edit with an empty old_string creates a missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "nested", "created.txt");
  const current = session();
  const result = await executeFileTool(
    "Edit",
    { file_path: filePath, old_string: "", new_string: "created by edit\n" },
    [directory],
    current,
  );
  assert.match(result.output, /^--- \/dev\/null\n\+\+\+ b\/.*\/nested\/created\.txt\n@@/);
  assert.equal(await readFile(filePath, "utf8"), "created by edit\n");
});

test("an aborted session prevents non-shell file tools from executing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "should-not-exist.txt");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeFileTool(
      "Write",
      { file_path: filePath, content: "not written\n" },
      [directory],
      session(),
      directory,
      controller.signal,
    ),
    { name: "AbortError" },
  );
  await assert.rejects(stat(filePath), { code: "ENOENT" });
});

test("Write and Edit finish safely when abort arrives after they start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const writePath = join(directory, "write.txt");
  const editPath = join(directory, "edit.txt");

  const writeController = new AbortController();
  const write = executeFileTool(
    "Write",
    { file_path: writePath, content: "complete write\n" },
    [directory],
    session(),
    directory,
    writeController.signal,
  );
  writeController.abort();
  await write;
  assert.equal(await readFile(writePath, "utf8"), "complete write\n");

  const editController = new AbortController();
  const edit = executeFileTool(
    "Edit",
    { file_path: editPath, old_string: "", new_string: "complete edit\n" },
    [directory],
    session(),
    directory,
    editController.signal,
  );
  editController.abort();
  await edit;
  assert.equal(await readFile(editPath, "utf8"), "complete edit\n");
});

test("file tools resolve relative paths from CWD and reject binary and outside paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const outside = await mkdtemp(join(tmpdir(), "amber-outside-"));
  const binaryPath = join(directory, "binary.dat");
  const imagePath = join(directory, "image.png");
  const outsidePath = join(outside, "outside.txt");
  await writeFile(binaryPath, Buffer.from([1, 0, 2]));
  await writeFile(imagePath, "not really an image", "utf8");
  await writeFile(outsidePath, "outside", "utf8");
  const current = session();

  await writeFile(join(directory, "relative.txt"), "relative", "utf8");
  const canonicalRelativePath = await realpath(join(directory, "relative.txt"));
  const relative = await executeFileTool("Read", { file_path: "relative.txt" }, [directory], current);
  assert.equal(relative.filePath, canonicalRelativePath);
  assert.equal(relative.resultText, "     1→relative");
  await assert.rejects(executeFileTool("Read", { file_path: binaryPath }, [directory], current), /only supports text/);
  await assert.rejects(executeFileTool("Read", { file_path: imagePath }, [directory], current), /unsupported or corrupt image/);
  await assert.rejects(executeFileTool("Write", { file_path: imagePath, content: "text" }, [directory], current), /Images can be read but not written/);
  await assert.rejects(
    executeFileTool("Edit", { file_path: imagePath, old_string: "not", new_string: "still not" }, [directory], current),
    /Images can be read but not written/,
  );
  await assert.rejects(executeFileTool("Read", { file_path: outsidePath }, [directory], current), /outside the project/);
});

test("Read returns image bytes as an image on the tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-images-"));
  const pngPath = join(directory, "shot.png");
  const jpegPath = join(directory, "photo.jpg");
  const pdfPath = join(directory, "doc.pdf");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6)]);
  await writeFile(pngPath, pngBytes);
  await writeFile(jpegPath, jpegBytes);
  await writeFile(pdfPath, "%PDF-1.4", "utf8");
  const current = session();

  const canonicalPngPath = await realpath(pngPath);
  const png = await executeFileTool("Read", { file_path: pngPath }, [directory], current);
  assert.equal(png.filePath, canonicalPngPath);
  assert.deepEqual(png.image, { mediaType: "image/png", data: pngBytes.toString("base64") });
  assert.match(png.resultText, /Read .*shot\.png: image\/png image \(.* KiB\) attached to this tool result\./);
  assert.equal(png.output, png.resultText);
  assert.equal(png.readRange, undefined);
  assert.equal(current.fileReadState?.[canonicalPngPath], undefined);

  const jpeg = await executeFileTool("Read", { file_path: jpegPath }, [directory], current);
  assert.deepEqual(jpeg.image, { mediaType: "image/jpeg", data: jpegBytes.toString("base64") });

  await assert.rejects(executeFileTool("Read", { file_path: pdfPath }, [directory], current), /Read does not support PDFs/);
});

test("plan mode permits only its plan file through Write and Edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-plan-files-"));
  const planPath = join(directory, "plans", "quiet.river.stone.md");
  const sourcePath = join(directory, "source.ts");
  const current = session();
  const policy = { onlyMutationPath: planPath };

  await executeFileTool(
    "Write",
    { file_path: planPath, content: "# Plan\n" },
    [directory],
    current,
    directory,
    undefined,
    policy,
  );
  assert.equal(await readFile(planPath, "utf8"), "# Plan\n");
  await executeFileTool(
    "Edit",
    { file_path: planPath, old_string: "# Plan", new_string: "# Revised plan" },
    [directory],
    current,
    directory,
    undefined,
    policy,
  );
  assert.equal(await readFile(planPath, "utf8"), "# Revised plan\n");
  await assert.rejects(
    executeFileTool(
      "Write",
      { file_path: sourcePath, content: "changed\n" },
      [directory],
      current,
      directory,
      undefined,
      policy,
    ),
    /only permits Write or Edit for the active plan file/,
  );
  await assert.rejects(
    executeFileTool(
      "Edit",
      { file_path: sourcePath, old_string: "", new_string: "changed\n" },
      [directory],
      current,
      directory,
      undefined,
      policy,
    ),
    /only permits Write or Edit for the active plan file/,
  );

  await executeFileTool("Write", { file_path: sourcePath, content: "normal mode\n" }, [directory], current, directory);
  assert.equal(await readFile(sourcePath, "utf8"), "normal mode\n");
});
