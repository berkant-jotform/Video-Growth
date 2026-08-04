import assert from "node:assert/strict";
import { test } from "node:test";
import { runFinishCheckWorkflow } from "../lib/finish-check-workflow.mjs";

test("finish check refreshes the queue after a successful Studio check", async () => {
  const calls = [];
  const stages = [];
  const result = await runFinishCheckWorkflow({
    checkSignals: async () => { calls.push("signals"); return { ok: true }; },
    refreshQueue: async () => { calls.push("refresh"); return { ok: true }; },
    onStage: (stage) => stages.push(stage)
  });
  assert.deepEqual(calls, ["signals", "refresh"]);
  assert.equal(result.operation.extension, "ok");
  assert.equal(result.operation.refresh, "ok");
  assert.equal(stages.at(-1).running, false);
});

test("finish check still refreshes the queue when the extension is offline", async () => {
  let refreshed = false;
  const result = await runFinishCheckWorkflow({
    checkSignals: async () => { throw new Error("Extension bridge offline."); },
    refreshQueue: async () => { refreshed = true; return { ok: true }; }
  });
  assert.equal(refreshed, true);
  assert.equal(result.operation.extension, "warn");
  assert.equal(result.operation.refresh, "ok");
});

test("finish check preserves extension success when the queue refresh fails", async () => {
  const result = await runFinishCheckWorkflow({
    checkSignals: async () => ({ ok: true }),
    refreshQueue: async () => ({ ok: false, error: "Database unavailable" })
  });
  assert.equal(result.operation.extension, "ok");
  assert.equal(result.operation.refresh, "error");
});

test("finish check stops before queue refresh when requested during Studio check", async () => {
  let stopRequested = false;
  let refreshed = false;
  const result = await runFinishCheckWorkflow({
    checkSignals: async () => {
      stopRequested = true;
      return { ok: true };
    },
    refreshQueue: async () => {
      refreshed = true;
      return { ok: true };
    },
    shouldStop: () => stopRequested
  });

  assert.equal(refreshed, false);
  assert.equal(result.refreshResult.cancelled, true);
  assert.equal(result.operation.stopped, true);
  assert.equal(result.operation.refresh, "stopped");
});

test("finish check reports a cooperatively cancelled queue refresh as stopped", async () => {
  const result = await runFinishCheckWorkflow({
    checkSignals: async () => ({ ok: true }),
    refreshQueue: async () => ({ ok: false, cancelled: true })
  });

  assert.equal(result.operation.stopped, true);
  assert.equal(result.operation.refresh, "stopped");
  assert.match(result.operation.message, /existing queue remains available/i);
});
