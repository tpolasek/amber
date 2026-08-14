import test from "node:test";
import assert from "node:assert/strict";
import { ActiveSessionRuns, abortSessionOperations } from "../src/session-aborts.js";

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

test("session abort stops only agent background tasks after aborting active runs", async () => {
  const runs = new ActiveSessionRuns();
  const root = new AbortController();
  const activeAgent = new AbortController();
  runs.register("root", undefined, root);
  runs.register("active-agent", "root", activeAgent);

  const stoppedSessions: string[] = [];
  const backgroundTasks = {
    stopSession(sessionId: string): Array<{ id: string }> {
      stoppedSessions.push(sessionId);
      return [{ id: `background-${sessionId}` }];
    },
  };

  const result = await abortSessionOperations(
    "root",
    runs,
    backgroundTasks,
    async () => {
      assert.equal(root.signal.aborted, true);
      assert.equal(activeAgent.signal.aborted, true);
      return [
        { id: "root" },
        { id: "active-agent" },
        { id: "inactive-agent" },
      ];
    },
  );

  assert.deepEqual(result.sessionIds, ["root", "active-agent"]);
  assert.deepEqual(stoppedSessions, ["active-agent", "inactive-agent"]);
  assert.deepEqual(result.backgroundTaskIds, ["background-active-agent", "background-inactive-agent"]);
});
