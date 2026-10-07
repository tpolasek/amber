import test from "node:test";
import assert from "node:assert/strict";

// renderDiff builds spans through document.createElement and appends them,
// so a fake element factory and container are all the DOM it needs.
type FakeSpan = { className: string; textContent: string };
const created: FakeSpan[] = [];

globalThis.document = {
  createElement(tag: string) {
    assert.equal(tag, "span");
    const span: FakeSpan = { className: "", textContent: "" };
    created.push(span);
    return span;
  },
} as unknown as Document;

const { renderDiff } = await import("../src/client-diff.js");

function fakeContainer(): { children: unknown[]; append(node: unknown): void } {
  return {
    children: [],
    append(node: unknown) {
      this.children.push(node);
    },
  };
}

test("renders each diff line as a classed span separated by newlines", () => {
  created.length = 0;
  const container = fakeContainer();

  renderDiff(container as unknown as HTMLElement, "@@ -1 +1 @@\n-old\n+new\n context");

  assert.deepEqual(
    created.map((span) => span.className),
    ["diff-hunk", "diff-deletion", "diff-addition", "diff-context"],
  );
  assert.deepEqual(
    created.map((span) => span.textContent),
    ["@@ -1 +1 @@", "-old", "+new", " context"],
  );
  assert.deepEqual(container.children, [created[0], "\n", created[1], "\n", created[2], "\n", created[3]]);
});

test("renders an empty trailing line as a single space", () => {
  created.length = 0;
  const container = fakeContainer();

  renderDiff(container as unknown as HTMLElement, "same\n");

  assert.deepEqual(created.map((span) => span.textContent), ["same", " "]);
  assert.deepEqual(container.children, [created[0], "\n", created[1]]);
});
