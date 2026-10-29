// test/cli-render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, displayWidth, joinRuns } from "../src/cli/render.js";
import { DARK, LIGHT } from "../src/cli/theme.js";

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
  const output = renderMarkdown("# Title\n\nsome *ital* **bold** `code`", { width: 40, color: true, theme: DARK });
  assert.equal(output, `\x1b[1mTitle\x1b[0m\n\nsome \x1b[3mital\x1b[0m \x1b[1mbold\x1b[0m \x1b[${DARK.code}mcode\x1b[0m`);
});

test("inline code picks up the theme", () => {
  const dark = renderMarkdown("`x`", { width: 40, color: true, theme: DARK });
  const light = renderMarkdown("`x`", { width: 40, color: true, theme: LIGHT });
  assert.equal(dark, `\x1b[${DARK.code}mx\x1b[0m`);
  assert.equal(light, `\x1b[${LIGHT.code}mx\x1b[0m`);
  assert.notEqual(dark, light);
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

test("renders nested lists with hanging indents", () => {
  const output = render("- one\n- two\n  - two-a\n- three", 40);
  assert.deepEqual(output.split("\n"), ["- one", "- two", "  - two-a", "- three"]);
});

test("renders ordered lists starting at their start attribute", () => {
  assert.deepEqual(render("3. three\n4. four", 40).split("\n"), ["3. three", "4. four"]);
});

test("wraps list item continuation under the item content", () => {
  const output = render("- aaaa bbbb cccc dddd", 12);
  assert.deepEqual(output.split("\n"), ["- aaaa bbbb", "  cccc dddd"]);
});

test("renders blockquotes with a dim bar on every line", () => {
  const output = renderMarkdown("> quoted text\n> more", { width: 40, color: true });
  assert.equal(output, "\x1b[2m> \x1b[0mquoted text\n\x1b[2m> \x1b[0mmore");
});

test("renders tables aligned, padded, and bold-headed", () => {
  const output = renderMarkdown("| name | value |\n|---:|---|\n| a | 1 |\n| bbb | 22 |", { width: 40, color: true });
  assert.deepEqual(output.split("\n"), [
    "\x1b[1m| name | value |\x1b[0m",
    "\x1b[2m|------|-------|\x1b[0m",
    "|    a | 1     |",
    "|  bbb | 22    |",
  ]);
});

test("shrinks and wraps over-wide table columns to the width", () => {
  const output = render("| left | right |\n|---|---|\n| aaaaaaaaaaaaaaaaaaaa | b |", 24);
  for (const line of output.split("\n")) assert.ok(displayWidth(line) <= 24, line);
  assert.ok(output.includes("aaaaaaaaaa"));
  assert.ok(output.includes("aaaaaaaa"));
});

test("renders a list inside a blockquote", () => {
  const output = render("> - one\n> - two", 40);
  assert.deepEqual(output.split("\n"), ["> - one", "> - two"]);
});

test("keeps the list marker when a blockquote is the item's first block", () => {
  assert.deepEqual(render("- > quoted", 40).split("\n"), ["- > quoted"]);
});

test("keeps the list marker on a fenced code block inside an item", () => {
  const output = render("- ```\n  hi\n  ```", 40);
  assert.ok(output.split("\n").some((line) => line.startsWith("- ")), output);
});

test("joinRuns merges adjacent runs sharing codes into one escape pair", () => {
  assert.equal(
    joinRuns([{ text: "a", codes: "2" }, { text: "b", codes: "2" }, { text: "c" }, { text: "d", codes: "1" }], true),
    "\x1b[2mab\x1b[0mc\x1b[1md\x1b[0m",
  );
  assert.equal(joinRuns([{ text: "a", codes: "2" }], false), "a");
});

test("fenced code fills each line as a shaded block in color mode", () => {
  const output = renderMarkdown("```js\nconst x = 1;\n```", { width: 40, color: true, theme: DARK });
  assert.deepEqual(output.split("\n"), [`\x1b[${DARK.codeBlock}m${"  const x = 1;".padEnd(40)}\x1b[0m`]);
});

test("code block fills reach the 80-column minimum, never past the width", () => {
  const narrow = renderMarkdown("```\nshort\n```", { width: 100, color: true, theme: LIGHT }).split("\n")[0]!;
  assert.equal(displayWidth(narrow.replace(/\x1b\[[0-9;]*m/g, "")), 80);
  assert.ok(narrow.startsWith(`\x1b[${LIGHT.codeBlock}m`));
  const clipped = renderMarkdown(`\`\`\`\n${"x".repeat(90)}\n\`\`\``, { width: 60, color: true, theme: DARK }).split("\n")[0]!;
  assert.equal(displayWidth(clipped.replace(/\x1b\[[0-9;]*m/g, "")), 92); // text plus indent, unpadded
});
