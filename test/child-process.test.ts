import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ChildStopper } from "../src/child-process.js";

function trackKills(t: TestContext): NodeJS.Signals[] {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  return [];
}

test("kills immediately when constructed with an already-aborted signal", (t) => {
  const kills = trackKills(t);
  const controller = new AbortController();
  controller.abort();

  new ChildStopper((signalName) => kills.push(signalName), controller.signal);

  assert.deepEqual(kills, ["SIGTERM"]);
});

test("aborting after construction sends SIGTERM exactly once even when abort repeats", (t) => {
  const kills = trackKills(t);
  const controller = new AbortController();
  new ChildStopper((signalName) => kills.push(signalName), controller.signal);

  controller.abort();
  controller.abort();

  assert.deepEqual(kills, ["SIGTERM"]);
});

test("stop escalates from SIGTERM to SIGKILL after one second", (t) => {
  const kills = trackKills(t);
  const stopper = new ChildStopper((signalName) => kills.push(signalName), new AbortController().signal);

  stopper.stop();
  assert.deepEqual(kills, ["SIGTERM"]);

  t.mock.timers.tick(999);
  assert.deepEqual(kills, ["SIGTERM"]);

  t.mock.timers.tick(1);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
});

test("repeated stop calls schedule a single SIGKILL escalation", (t) => {
  const kills = trackKills(t);
  const stopper = new ChildStopper((signalName) => kills.push(signalName), new AbortController().signal);

  stopper.stop();
  stopper.stop();
  stopper.stop();
  t.mock.timers.tick(1_000);

  assert.equal(kills.filter((signalName) => signalName === "SIGKILL").length, 1);
});

test("settle clears the escalation timer so no SIGKILL fires", (t) => {
  const kills = trackKills(t);
  const stopper = new ChildStopper((signalName) => kills.push(signalName), new AbortController().signal);

  stopper.stop();
  stopper.settle();
  t.mock.timers.tick(1_000);

  assert.deepEqual(kills, ["SIGTERM"]);
});

test("settle removes the abort listener so a later abort does not kill", (t) => {
  const kills = trackKills(t);
  const controller = new AbortController();
  const stopper = new ChildStopper((signalName) => kills.push(signalName), controller.signal);

  stopper.settle();
  controller.abort();
  t.mock.timers.tick(1_000);

  assert.deepEqual(kills, []);
});
