import test from "node:test";
import assert from "node:assert/strict";
import { ActiveSessionRuns } from "../src/session-aborts.js";

test("aborts an active session and every nested agent run", () => {
  const runs = new ActiveSessionRuns();
  const root = new AbortController();
  const firstAgent = new AbortController();
  const nestedAgent = new AbortController();
  const unrelated = new AbortController();
  runs.register("root", undefined, root);
  runs.register("agent", "root", firstAgent);
  runs.register("nested", "agent", nestedAgent);
  runs.register("other", undefined, unrelated);

  assert.deepEqual(runs.abortTree("root"), ["root", "agent", "nested"]);
  assert.equal(root.signal.aborted, true);
  assert.equal(firstAgent.signal.aborted, true);
  assert.equal(nestedAgent.signal.aborted, true);
  assert.equal(unrelated.signal.aborted, false);
});

test("unregister only removes the controller for the matching run", () => {
  const runs = new ActiveSessionRuns();
  const stale = new AbortController();
  const current = new AbortController();
  runs.register("session", undefined, stale);
  runs.register("session", undefined, current);

  runs.unregister("session", stale);
  assert.equal(runs.has("session"), true);
  assert.deepEqual(runs.abortTree("session"), ["session"]);
  assert.equal(stale.signal.aborted, false);
  assert.equal(current.signal.aborted, true);
});
