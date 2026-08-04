import assert from "node:assert/strict";
import test from "node:test";
import { planLegacyYearlessDateReconciliation } from "../lib/legacy-date-reconciliation.mjs";

function pair(overrides = {}) {
  return {
    legacyRunId: "legacy-run",
    legacyTestId: "legacy-test",
    targetRunId: "target-run",
    targetTestId: "target-test",
    videoId: "video123",
    testType: "thumbnail",
    optionFingerprint: "options",
    legacyStartDate: "2001-07-24",
    targetStartDate: "2026-07-24",
    targetStatus: "running",
    targetUpdatedAt: "2026-07-25T00:00:00Z",
    ...overrides
  };
}

test("reconciles a legacy yearless-date artifact with its plausible dated twin", () => {
  const result = planLegacyYearlessDateReconciliation([pair()]);
  assert.deepEqual(result, {
    mappings: [{
      legacyRunId: "legacy-run",
      legacyTestId: "legacy-test",
      targetRunId: "target-run",
      targetTestId: "target-test"
    }],
    ambiguous: []
  });
});

test("retires a legacy raw artifact already linked to the canonical logical test", () => {
  const result = planLegacyYearlessDateReconciliation([
    pair({ legacyTestId: "same-test", targetTestId: "same-test" })
  ]);
  assert.equal(result.mappings.length, 1);
  assert.equal(result.mappings[0].legacyTestId, "same-test");
  assert.equal(result.mappings[0].targetTestId, "same-test");
});

test("does not reconcile different month/day values", () => {
  const result = planLegacyYearlessDateReconciliation([
    pair({ targetStartDate: "2026-07-25" })
  ]);
  assert.equal(result.mappings.length, 0);
});

test("prefers a completed target when duplicate source copies exist", () => {
  const result = planLegacyYearlessDateReconciliation([
    pair({ targetRunId: "running", targetStatus: "running" }),
    pair({ targetRunId: "closed", targetStatus: "sheet_marked_done" })
  ]);
  assert.equal(result.mappings[0].targetRunId, "closed");
});

test("refuses an ambiguous legacy identity instead of guessing", () => {
  const result = planLegacyYearlessDateReconciliation([
    pair({ targetRunId: "one", targetTestId: "test-one" }),
    pair({ targetRunId: "two", targetTestId: "test-two" })
  ]);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.ambiguous.length, 1);
});

test("keeps every legacy raw row when several share one logical identity", () => {
  const result = planLegacyYearlessDateReconciliation([
    pair({ legacyRunId: "legacy-one" }),
    pair({ legacyRunId: "legacy-two" })
  ]);
  assert.deepEqual(result.mappings.map((item) => item.legacyRunId).sort(), [
    "legacy-one",
    "legacy-two"
  ]);
});
