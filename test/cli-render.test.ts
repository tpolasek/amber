// test/cli-render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, displayWidth } from "../src/cli/render.js";

function render(markdown: string, width = 40, color = false): string {
  return renderMarkdown(markdown, { width, color });
}

test("displayWidth counts CJK characters as two columns", () => {
  assert.equal(displayWidth("ab界"), 4);
  assert.equal(displayWidth("a\u0301b"), 2);
});

test("renders paragraphs wrapped to width", () => {
  const output = render("aaaa bbbb cccc dddd eeee ffff", 20);
  assert.deepEqual(output.split("\n"), ["aaaa bbbb cccc dddd", "eeee ffff"]);
});

test("renders headings, emphasis, and inline code", () => {
  const output = renderMarkdown("# Title\n\nsome *ital* **bold** `code`", { width: 40, color: true });
  assert.equal(output, "\x1b[1mTitle\x1b[0m\n\nsome \x1b[3mital\x1b[0m \x1b[1mbold\x1b[0m \x1b[36mcode\x1b[0m");
});

test("renders fenced code dimmed and indented without wrapping", () => {
  const output = render("```js\nconst x = 1;\nconst veryLongLine = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\";\n```", 20);
  assert.deepEqual(output.split("\n"), [
    "  const x = 1;",
    "  const veryLongLine = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\";",
  ]);
});

test("renders links as text plus url only when they differ", () => {
  const output = render("[Amber](https://amber.dev) and <https://amber.dev>", 60);
  assert.equal(output, "Amber (https://amber.dev) and https://amber.dev");
});

test("renders images as placeholders", () => {
  assert.equal(render("![alt text](pic.png)", 40), "[img: alt text]");
});

test("collapses blank lines between blocks to one", () => {
  assert.equal(render("one\n\n\n\ntwo", 40), "one\n\ntwo");
});

test("renders hr as a short dim rule", () => {
  const output = renderMarkdown("a\n\n---\n\nb", { width: 40, color: true });
  assert.equal(output, "a\n\n\x1b[2m--------\x1b[0m\n\nb");
});

test("hard-split makes progress when one wide character exceeds the width", () => {
  assert.equal(renderMarkdown("界", { width: 1, color: false }), "界");
});
