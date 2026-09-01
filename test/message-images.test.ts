import test from "node:test";
import assert from "node:assert/strict";
import {
  imageDataUrl,
  imageMediaTypeForPath,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
  parseMessageImages,
  sniffImageMediaType,
  stripProviderImages,
} from "../src/message-images.js";
import type { ProviderMessage } from "../src/types.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function errorOf(result: ReturnType<typeof parseMessageImages>): string {
  return "error" in result ? result.error : "";
}

test("maps image paths to media types", () => {
  assert.equal(imageMediaTypeForPath("/tmp/shot.PNG"), "image/png");
  assert.equal(imageMediaTypeForPath("/tmp/photo.jpeg"), "image/jpeg");
  assert.equal(imageMediaTypeForPath("/tmp/photo.jpg"), "image/jpeg");
  assert.equal(imageMediaTypeForPath("/tmp/anim.gif"), "image/gif");
  assert.equal(imageMediaTypeForPath("/tmp/pic.webp"), "image/webp");
  assert.equal(imageMediaTypeForPath("/tmp/notes.txt"), undefined);
  assert.equal(imageMediaTypeForPath("/tmp/noext"), undefined);
});

test("sniffs media types from magic bytes", () => {
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), "image/png");
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMediaType(Buffer.from("GIF89a", "latin1")), "image/gif");
  assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")])), "image/webp");
  assert.equal(sniffImageMediaType(Buffer.from("not really an image")), undefined);
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined);
});

test("formats data URLs", () => {
  assert.equal(imageDataUrl({ mediaType: "image/png", data: "aGVsbG8=" }), "data:image/png;base64,aGVsbG8=");
});

test("parses valid image arrays", () => {
  assert.deepEqual(parseMessageImages(undefined), { images: [] });
  assert.deepEqual(parseMessageImages(null), { images: [] });
  assert.deepEqual(parseMessageImages([]), { images: [] });
  const parsed = parseMessageImages([{ mediaType: "image/png", data: PNG_BASE64 }]);
  assert.deepEqual(parsed, { images: [{ mediaType: "image/png", data: PNG_BASE64 }] });
});

test("rejects malformed image input", () => {
  assert.match(errorOf(parseMessageImages("nope")), /array/);
  assert.match(errorOf(parseMessageImages([42])), /mediaType and data/);
  assert.match(errorOf(parseMessageImages([{ mediaType: "image/bmp", data: "aGVsbG8=" }])), /media type/);
  assert.match(errorOf(parseMessageImages([{ mediaType: "image/png", data: "not base64!" }])), /base64/);
  assert.match(errorOf(parseMessageImages([{ mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=" }])), /base64/);
});

test("enforces per-image, total, and count limits", () => {
  const oversized = "A".repeat(Math.ceil((MAX_TOTAL_IMAGE_BYTES + 1) * 4 / 3));
  assert.match(errorOf(parseMessageImages([{ mediaType: "image/png", data: oversized }])), /at most 32 MiB/);

  const perImage = "A".repeat(Math.ceil((MAX_TOTAL_IMAGE_BYTES / 2) * 4 / 3));
  const over = parseMessageImages([
    { mediaType: "image/png", data: perImage },
    { mediaType: "image/png", data: perImage },
    { mediaType: "image/png", data: perImage },
  ]);
  assert.match(errorOf(over), /total at most 64 MiB/);

  const tooMany = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mediaType: "image/png", data: "aGVsbG8=" }));
  assert.match(errorOf(parseMessageImages(tooMany)), /600 images/);
});

test("strips image blocks from provider history, including tool results", () => {
  const history: ProviderMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "What is this?" },
      ],
    },
    { role: "assistant", content: "Plain turn" },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-1",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "text", text: "Read the file." },
        ],
      }],
    },
  ];

  assert.deepEqual(stripProviderImages(history), [
    {
      role: "user",
      content: [
        { type: "text", text: "[image attached]" },
        { type: "text", text: "What is this?" },
      ],
    },
    { role: "assistant", content: "Plain turn" },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-1",
        content: [
          { type: "text", text: "[image attached]" },
          { type: "text", text: "Read the file." },
        ],
      }],
    },
  ]);
});
