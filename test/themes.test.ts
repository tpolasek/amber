import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root from `dist/test/themes.test.js`. */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const THEMES = ["dark", "light", "light+", "hacker", "greek"] as const;

function themeVariables(css: string, theme: string): Set<string> {
  const selector = `:root[data-theme="${theme}"]`;
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${selector} must exist in themes.css`);
  const open = css.indexOf("{", start);
  const block = css.slice(open + 1, css.indexOf("}", open));
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
}

test("every color theme defines the same palette variables", async () => {
  const css = await readFile(join(repositoryRoot, "public", "themes.css"), "utf8");
  // A theme is a whole palette: an omitted variable silently inherits another
  // theme's value, so every block must declare the same names.
  const baseline = themeVariables(css, "dark");
  assert.ok(baseline.size > 40, "the dark theme should declare the full palette");

  for (const theme of THEMES) {
    const variables = themeVariables(css, theme);
    const missing = [...baseline].filter((name) => !variables.has(name));
    const extra = [...variables].filter((name) => !baseline.has(name));
    assert.deepEqual(missing, [], `${theme} does not define ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${theme} defines unknown ${extra.join(", ")}`);
  }
});

test("the greek theme ships its backdrop and display faces", async () => {
  const styles = await readFile(join(repositoryRoot, "public", "styles.css"), "utf8");
  const html = await readFile(join(repositoryRoot, "public", "index.html"), "utf8");

  assert.match(html, /class="greek-scene"/);
  for (const asset of ["architecture.webp", "athena.webp", "bodoni-moda.woff2", "dm-sans.woff2", "dm-sans-italic.woff2"]) {
    assert.ok(styles.includes(`/greek/${asset}`), `styles.css must reference /greek/${asset}`);
  }
  assert.match(styles, /:root\[data-theme="greek"\] \.greek-scene \{ display: block/);
});
