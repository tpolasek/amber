import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
});

test("Read returns numbered lines and records full-read state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
  const current = session();
  const result = await executeFileTool("Read", { file_path: filePath }, [directory], current);

  assert.equal(result.filePath, filePath);
  assert.equal(result.output, "Read 3 lines");
  assert.equal(result.resultText, "     1→first\n     2→second\n     3→third");
  assert.equal(current.fileReadState?.[filePath]?.full, true);
});

test("partial Read does not authorize an existing-file write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
  const current = session();
  await executeFileTool("Read", { file_path: filePath, offset: 2, limit: 1 }, [directory], current);
  assert.equal(current.fileReadState?.[filePath]?.full, false);
  await assert.rejects(
    executeFileTool("Write", { file_path: filePath, content: "replacement\n" }, [directory], current),
    /not been fully read/,
  );
});

test("Write creates nested files and requires a fresh read before overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const filePath = join(directory, "nested", "sample.txt");
  const current = session();
  const created = await executeFileTool("Write", { file_path: filePath, content: "created\n" }, [directory], current);
  assert.match(created.output, /^--- \/dev\/null\n\+\+\+ b\/.*\/nested\/sample\.txt\n@@ -0,0 \+1,1 @@\n\+created$/);
  assert.equal(await readFile(filePath, "utf8"), "created\n");

  await executeFileTool("Write", { file_path: filePath, content: "updated\n" }, [directory], current);
  assert.equal(await readFile(filePath, "utf8"), "updated\n");

  await writeFile(filePath, "external change\n", "utf8");
  await assert.rejects(
    executeFileTool("Write", { file_path: filePath, content: "stale write\n" }, [directory], current),
    /modified since read/,
  );
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

test("file tools reject relative, binary, and outside paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amber-files-"));
  const outside = await mkdtemp(join(tmpdir(), "amber-outside-"));
  const binaryPath = join(directory, "binary.dat");
  const imagePath = join(directory, "image.png");
  const outsidePath = join(outside, "outside.txt");
  await writeFile(binaryPath, Buffer.from([1, 0, 2]));
  await writeFile(imagePath, "not really an image", "utf8");
  await writeFile(outsidePath, "outside", "utf8");
  const current = session();

  await assert.rejects(executeFileTool("Read", { file_path: "relative.txt" }, [directory], current), /must be absolute/);
  await assert.rejects(executeFileTool("Read", { file_path: binaryPath }, [directory], current), /only supports text/);
  await assert.rejects(executeFileTool("Read", { file_path: imagePath }, [directory], current), /images, PDFs, and notebooks/);
  await assert.rejects(executeFileTool("Write", { file_path: imagePath, content: "text" }, [directory], current), /images, PDFs, and notebooks/);
  await assert.rejects(
    executeFileTool("Edit", { file_path: imagePath, old_string: "not", new_string: "still not" }, [directory], current),
    /images, PDFs, and notebooks/,
  );
  await assert.rejects(executeFileTool("Read", { file_path: outsidePath }, [directory], current), /outside the project/);
});
