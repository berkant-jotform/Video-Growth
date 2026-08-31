import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_JOB_MAX_ATTEMPTS,
  connectorJobRecoveryDecision
} from "../lib/connector-job-state.mjs";

test("retries an interrupted browser check before the attempt limit", () => {
  assert.equal(connectorJobRecoveryDecision({ status: "running", attemptCount: 1 }), "retry");
  assert.equal(connectorJobRecoveryDecision({ status: "claimed", attemptCount: 2 }), "retry");
});

test("fails an interrupted browser check after the final attempt", () => {
  assert.equal(
    connectorJobRecoveryDecision({ status: "running", attemptCount: CONNECTOR_JOB_MAX_ATTEMPTS }),
    "failed"
  );
});

test("finishes an abandoned cancellation instead of retrying it", () => {
  assert.equal(connectorJobRecoveryDecision({ status: "cancel_requested", attemptCount: 1 }), "cancelled");
  assert.equal(connectorJobRecoveryDecision({ status: "completed", attemptCount: 1 }), "unchanged");
});
