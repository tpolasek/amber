// test/cli-theme.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { DARK, LIGHT, themeFor } from "../src/cli/theme.js";

test("themeFor maps names to palettes", () => {
  assert.equal(themeFor("dark"), DARK);
  assert.equal(themeFor("light"), LIGHT);
});

test("thinking is a distinct foreground hue without a background fill", () => {
  for (const theme of [DARK, LIGHT]) {
    for (const slot of ["thinking", "thinkingHeader"] as const) {
      assert.ok(!theme[slot].includes("48;"), `${slot} should carry no background`);
      assert.ok(theme[slot].includes("38;5;"), `${slot} should be a 256-color hue`);
    }
  }
  assert.notEqual(LIGHT.thinking, DARK.thinking);
});

test("the busy pill shares the meter strip's fill and accent font", () => {
  for (const theme of [DARK, LIGHT]) {
    assert.ok(theme.statusActive.includes(theme.meterFill), "pill should sit on the meter fill");
    assert.ok(theme.statusActive.includes(theme.accent), "pill font should be the accent color");
  }
});

test("slots needing a 256-color hue differ per theme; shared ANSI basics do not", () => {
  for (const slot of ["prompt", "thinking", "thinkingHeader", "toolName", "error", "diffDel", "code", "accent", "statusActive", "assistantHeader", "meterValue", "meterFill"] as const) {
    assert.notEqual(LIGHT[slot], DARK[slot], `${slot} should be theme-specific`);
  }
  for (const slot of ["meta", "toolOk", "toolErr", "toolArg", "toolTail", "diffAdd", "diffCtx"] as const) {
    assert.equal(LIGHT[slot], DARK[slot], `${slot} should use the shared short ANSI code`);
    assert.ok(!DARK[slot].includes("5;"), `${slot} should stay a basic ANSI code`);
  }
});

test("the pill keeps its bold font switch on both themes", () => {
  for (const theme of [DARK, LIGHT]) {
    assert.ok(theme.statusActive.startsWith("1;"), "the pill font should stay bold");
  }
});

test("code blocks carry the shaded combo thinking once used", () => {
  for (const theme of [DARK, LIGHT]) {
    assert.ok(theme.codeBlock.includes("48;5;"), "code blocks should fill the background");
    assert.ok(theme.codeBlock.split(";")[0] === "38" || theme.codeBlock.startsWith("38;"), "fg first");
  }
  assert.notEqual(LIGHT.codeBlock, DARK.codeBlock);
});

test("the assistant header is regular magenta, not the accent", () => {
  for (const theme of [DARK, LIGHT]) {
    assert.ok(theme.assistantHeader.includes(";35;"), "regular ANSI magenta");
    assert.ok(theme.assistantHeader.includes(theme.meterFill), "keeps the strip fill");
    assert.ok(!theme.assistantHeader.includes(theme.accent), "must not reuse the accent");
  }
});
