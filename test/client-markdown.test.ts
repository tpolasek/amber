import test from "node:test";
import assert from "node:assert/strict";
import markdownit from "markdown-it";

// The browser page loads markdown-it as a UMD global; the module under test
// reads that global at import time, so define it first.
(globalThis as Record<string, unknown>).markdownit = markdownit;

const { markdown } = await import("../src/client-markdown.js");

test("the configured renderer escapes raw HTML", () => {
  const rendered = markdown.render('<script>alert("no")</script>');
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;/);
});

test("the configured renderer linkifies bare domains with fuzzy links", () => {
  const rendered = markdown.render("See github.com/owner/repo for the source.");
  assert.match(rendered, /href="http:\/\/github\.com\/owner\/repo"/);
});

test("the configured renderer still renders ordinary Markdown", () => {
  const rendered = markdown.render("# Title\n\n**bold** and `code`");
  assert.match(rendered, /<h1>Title<\/h1>/);
  assert.match(rendered, /<strong>bold<\/strong>/);
  assert.match(rendered, /<code>code<\/code>/);
});
