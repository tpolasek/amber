import test from "node:test";
import assert from "node:assert/strict";
import markdownit from "markdown-it";

const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });

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
