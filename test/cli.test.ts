import assert from "node:assert/strict";
import test from "node:test";
import { listenErrorMessage, parseCliCommand, startupErrorMessage, usageText } from "../src/cli.js";

test("no arguments starts the server", () => {
  assert.deepEqual(parseCliCommand([]), { kind: "start" });
});

test("help flags are recognised", () => {
  assert.deepEqual(parseCliCommand(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliCommand(["-h"]), { kind: "help" });
});

test("version flags are recognised", () => {
  assert.deepEqual(parseCliCommand(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliCommand(["-v"]), { kind: "version" });
});

test("help wins over other arguments", () => {
  assert.deepEqual(parseCliCommand(["--version", "--help"]), { kind: "help" });
});

test("an unknown flag is reported rather than ignored", () => {
  assert.deepEqual(parseCliCommand(["--nope"]), { kind: "unknown", argument: "--nope" });
  assert.deepEqual(parseCliCommand(["serve"]), { kind: "unknown", argument: "serve" });
});

test("usage lists the supported flags and environment variables", () => {
  const usage = usageText();
  for (const expected of ["--help", "--version", "PORT", "HOST", "DATA_DIR"]) {
    assert.ok(usage.includes(expected), `usage should mention ${expected}`);
  }
});

test("an in-use port explains the conflict and how to change the port", () => {
  const error = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3000"), {
    code: "EADDRINUSE",
  });
  const message = listenErrorMessage(error, "127.0.0.1", 3000);
  assert.match(message, /127\.0\.0\.1:3000 is already in use/);
  assert.match(message, /PORT=3001/);
  assert.doesNotMatch(message, /Unhandled/);
});

test("a forbidden port names the permission problem", () => {
  const error = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
  const message = listenErrorMessage(error, "127.0.0.1", 80);
  assert.match(message, /permission/i);
  assert.match(message, /127\.0\.0\.1:80/);
});

test("any other listen failure still reports the underlying error", () => {
  const error = Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" });
  const message = listenErrorMessage(error, "10.0.0.1", 3000);
  assert.match(message, /10\.0\.0\.1:3000/);
  assert.match(message, /EADDRNOTAVAIL/);
});

test("an invalid settings file is reported without a stack trace", () => {
  const settingsPath = "/home/user/.amber/settings.toml";
  const error = new Error(`${settingsPath}: providers.openai.api must be anthropic or openai`);
  const message = startupErrorMessage(error, settingsPath);
  assert.match(message, /AMBER cannot start/);
  assert.match(message, /settings\.toml is not valid/);
  assert.match(message, /api must be anthropic or openai/);
  assert.match(message, /Edit \/home\/user\/\.amber\/settings\.toml and run amber again\./);
  assert.doesNotMatch(message, new RegExp(`${settingsPath}: providers`));
});

test("a startup failure outside the settings file keeps its own wording", () => {
  const settingsPath = "/home/user/.amber/settings.toml";
  const error = new Error("Could not discover models for provider 'openai': fetch failed");
  const message = startupErrorMessage(error, settingsPath);
  assert.match(message, /AMBER cannot start: Could not discover models for provider 'openai': fetch failed/);
  assert.match(message, /\/home\/user\/\.amber\/settings\.toml/);
  assert.doesNotMatch(message, /is not valid/);
});

test("a non-error startup failure is still reported readably", () => {
  const message = startupErrorMessage("boom", "/home/user/.amber/settings.toml");
  assert.match(message, /AMBER cannot start: boom/);
});
