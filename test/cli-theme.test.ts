// test/cli-theme.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { DARK, LIGHT, themeFor } from "../src/cli/theme.js";

test("themeFor maps names to palettes", () => {
  assert.equal(themeFor("dark"), DARK);
  assert.equal(themeFor("light"), LIGHT);
});

test("thinking slots fill the background and differ per theme", () => {
  for (const slot of ["thinking", "thinkingHeader"] as const) {
    assert.ok(DARK[slot].includes("48;5;"), `${slot} should shade the background`);
    assert.ok(LIGHT[slot].includes("48;5;"), `${slot} should shade the background`);
    assert.notEqual(LIGHT[slot], DARK[slot]);
  }
});

test("slots needing a 256-color hue differ per theme; shared ANSI basics do not", () => {
  for (const slot of ["prompt", "thinking", "thinkingHeader", "toolName", "error", "diffDel", "code", "accent", "statusActive", "meterValue", "meterFill"] as const) {
    assert.notEqual(LIGHT[slot], DARK[slot], `${slot} should be theme-specific`);
  }
  for (const slot of ["meta", "toolOk", "toolErr", "toolArg", "toolTail", "diffAdd", "diffCtx"] as const) {
    assert.equal(LIGHT[slot], DARK[slot], `${slot} should use the shared short ANSI code`);
    assert.ok(!DARK[slot].includes("5;"), `${slot} should stay a basic ANSI code`);
  }
});

test("the dark busy pill is solid black on ANSI green, not a grey ramp code", () => {
  assert.equal(DARK.statusActive, "1;30;42");
});

test("the light busy pill fills the background with a color and switches font", () => {
  assert.ok(LIGHT.statusActive.includes("48;5;"), "light pill should fill the background");
  assert.ok(LIGHT.statusActive.startsWith("1;"), "the pill font should switch too");
});
