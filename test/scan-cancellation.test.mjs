import assert from "node:assert/strict";
import test from "node:test";

import {
  ScanCancelledError,
  isScanCancelledError,
  stoppedCheckOperation
} from "../lib/scan-cancellation.mjs";

test("scan cancellation has a stable machine-readable error contract", () => {
  const error = new ScanCancelledError();
  assert.equal(error.code, "SCAN_CANCELLED");
  assert.equal(error.cancelled, true);
  assert.equal(isScanCancelledError(error), true);
  assert.equal(isScanCancelledError(new Error("ordinary failure")), false);
});

test("stopped check operation preserves a restartable terminal state", () => {
  assert.deepEqual(stoppedCheckOperation({ extension: "ok" }), {
    running: false,
    stopped: true,
    extension: "ok",
    refresh: "stopped",
    message: "Check stopped safely. The existing queue remains available."
  });
});
