import test from "node:test";
import assert from "node:assert/strict";
import { browserCommand, browserUrl } from "../src/browser-launch.js";

test("builds a browser-safe local server URL", () => {
  assert.equal(browserUrl("127.0.0.1", 3000), "http://127.0.0.1:3000");
  assert.equal(browserUrl("0.0.0.0", 4000), "http://127.0.0.1:4000");
  assert.equal(browserUrl("::", 5000), "http://127.0.0.1:5000");
  assert.equal(browserUrl("::1", 6000), "http://[::1]:6000");
});

test("uses each platform's native browser opener", () => {
  const url = "http://127.0.0.1:3000";
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand(url, "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", url],
  });
  assert.equal(browserCommand(url, "aix"), null);
});
