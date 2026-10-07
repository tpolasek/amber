import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { authMutation } from "../src/client-api.js";
import type { Config } from "../src/client-types.js";

// client-state builds its `elements` record with document.getElementById at
// module load; only the truthiness of each lookup matters there.
const requestedIds: string[] = [];

function fakeElement(): HTMLElement {
  return {
    textContent: "",
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
  } as unknown as HTMLElement;
}

globalThis.document = {
  getElementById(id: string) {
    requestedIds.push(id);
    return fakeElement();
  },
} as unknown as Document;

const originalFetch = globalThis.fetch;
const { state, elements } = await import("../src/client-state.js");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("module load resolves every element it needs without throwing", () => {
  const keys = Object.keys(elements);
  assert.ok(keys.length > 40);
  for (const key of keys) {
    assert.ok((elements as Record<string, unknown>)[key], `elements.${key} is missing`);
  }
  for (const id of ["app", "terminal", "transcript", "composer", "toast", "settings-save", "goal-button"]) {
    assert.ok(requestedIds.includes(id), `expected getElementById(${id})`);
  }
  assert.equal(requestedIds.length, keys.length);
});

test("state starts idle with no session or config", () => {
  assert.deepEqual(state, {
    session: null,
    config: null,
    streaming: false,
    aborting: false,
    controller: null,
  });
});

test("state is a mutable record the client updates in place", () => {
  const controller = new AbortController();
  state.streaming = true;
  state.aborting = true;
  state.controller = controller;

  assert.equal(state.streaming, true);
  assert.equal(state.aborting, true);
  assert.equal(state.controller, controller);

  state.streaming = false;
  state.aborting = false;
  state.controller = null;
  assert.equal(state.streaming, false);
});

test("load-time provider reads the action token from state.config", async () => {
  state.config = null;
  await assert.rejects(
    () => authMutation("/api/settings", { method: "PUT" }),
    /Authentication settings are not initialized/,
  );

  const config: Config = {
    configured: true,
    authenticationRequired: false,
    provider: "anthropic",
    model: "claude-sonnet",
    defaultModel: "claude-sonnet",
    models: [],
    mode: "live",
    homeDirectory: "/home/amber",
    workspaceRoot: "/workspace",
    authActionToken: "state-token",
    theme: "dark",
  };
  state.config = config;

  let sentHeaders: Record<string, string> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await authMutation("/api/settings", { method: "PUT" });
  assert.equal(sentHeaders["x-amber-auth-action-token"], "state-token");
  state.config = null;
});
