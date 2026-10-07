import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("server-app serves API and static routes over HTTP", async (t) => {
  // server-app.ts reads DATA_DIR, PORT, HOST and the home directory at import
  // time, so isolate all mutable state before the dynamic import.
  const home = mkdtempSync(join(tmpdir(), "amber-server-app-"));
  const previousEnvironment = {
    DATA_DIR: process.env.DATA_DIR,
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    HOME: process.env.HOME,
    AMBER_NO_BROWSER: process.env.AMBER_NO_BROWSER,
  };
  process.env.DATA_DIR = join(home, "sessions");
  process.env.PORT = String(20000 + Math.floor(Math.random() * 20000));
  process.env.HOST = "127.0.0.1";
  process.env.HOME = home;
  process.env.AMBER_NO_BROWSER = "1";

  const { startAmberServer } = await import("../src/server-app.js");
  const { server, port } = await startAmberServer();
  if (!server.listening) await once(server, "listening");

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const base = `http://127.0.0.1:${port}`;

  await t.test("GET /api/config returns configuration JSON", async () => {
    const response = await fetch(`${base}/api/config`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const config = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof config.configured, "boolean");
    assert.equal(config.mode, "live");
    assert.equal(typeof config.workspaceRoot, "string");
    assert.equal(typeof config.authActionToken, "string");
    assert.ok(Array.isArray(config.models));
  });

  await t.test("GET /api/auth returns the provider list", async () => {
    const response = await fetch(`${base}/api/auth`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { providers: { id: string; configured: boolean }[] };
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.some((provider) => provider.id === "openai-codex"));
    assert.equal(typeof body.providers[0]?.configured, "boolean");
  });

  await t.test("GET /api/sessions returns an empty list for a fresh store", async () => {
    const response = await fetch(`${base}/api/sessions`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sessions: [] });
  });

  await t.test("unknown /api paths return a 404 JSON error", async () => {
    const response = await fetch(`${base}/api/not-a-real-route`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  });

  await t.test("GET /client.js serves the compiled browser client", async () => {
    const response = await fetch(`${base}/client.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    const source = await response.text();
    assert.ok(source.length > 100, "client script should not be empty");
    assert.ok(!source.trimStart().startsWith("<"), "client.js must not serve index.html");
  });

  await t.test("privileged endpoints reject requests without the action token", async () => {
    const response = await fetch(`${base}/api/auth/openai-codex/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "browser" }),
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /token/i);
  });
});
