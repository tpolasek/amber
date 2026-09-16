import test from "node:test";
import assert from "node:assert/strict";
import markdownit from "markdown-it";
import type { MarkdownRenderer } from "../src/client-types.js";

// Mirrors src/client-markdown.ts, which reads the markdown-it UMD global the
// browser page loads and so cannot be imported under Node.
const markdown: MarkdownRenderer = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
markdown.linkify.set({ fuzzyLink: true });

test("renders rich Markdown used by agent responses", () => {
  const rendered = markdown.render([
    "# Result",
    "",
    "| File | Status |",
    "| --- | --- |",
    "| app.ts | **ready** |",
    "",
    "```ts",
    "const ready = true;",
    "```",
  ].join("\n"));

  assert.match(rendered, /<h1>Result<\/h1>/);
  assert.match(rendered, /<table>/);
  assert.match(rendered, /<strong>ready<\/strong>/);
  assert.match(rendered, /<code class="language-ts">/);
});

test("escapes raw HTML and rejects unsafe link protocols", () => {
  const rendered = markdown.render('<script>alert("no")</script> [bad](javascript:alert(1))');
  assert.doesNotMatch(rendered, /<script>/);
  assert.doesNotMatch(rendered, /href="javascript:/);
  assert.match(rendered, /&lt;script&gt;/);
});

test("links explicit URLs and bare domains alike", () => {
  const rendered = markdown.render([
    "See https://github.com/owner/repo/pull/12#discussion_r1",
    "and github.com/owner/repo for the bare form.",
    "Reach dev@example.com or www.example.com/docs.",
  ].join("\n"));

  assert.match(rendered, /href="https:\/\/github\.com\/owner\/repo\/pull\/12#discussion_r1"/);
  assert.match(rendered, /href="http:\/\/github\.com\/owner\/repo"/);
  assert.match(rendered, /href="mailto:dev@example\.com"/);
  assert.match(rendered, /href="http:\/\/www\.example\.com\/docs"/);
});

test("accepted cost of fuzzy links: filenames with a TLD extension link too", () => {
  const rendered = markdown.render("Edit main.py and run.sh, then check README.md.");
  assert.match(rendered, /href="http:\/\/main\.py"/);
  assert.match(rendered, /href="http:\/\/run\.sh"/);
  assert.match(rendered, /href="http:\/\/README\.md"/);
});
