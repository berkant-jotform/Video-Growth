import assert from "node:assert/strict";
import test from "node:test";
import { planExactMaterialReconciliation } from "../lib/exact-material-reconciliation.mjs";

function candidate(overrides = {}) {
  return {
    testId: "test-a",
    videoId: "video",
    testType: "thumbnail",
    startDate: "2026-07-10",
    optionFingerprint: "options",
    status: "running",
    result: "unknown",
    resultEvidence: "unknown",
    explicitWinnerVariant: "",
    activeActions: [],
    updatedAt: "2026-07-10T00:00:00Z",
    ...overrides
  };
}

test("merges evidence-compatible identities with exact material equality", () => {
  const result = planExactMaterialReconciliation([
    candidate(),
    candidate({ testId: "test-b", status: "result_logged" })
  ]);
  assert.deepEqual(result.mappings, [{
    sourceTestId: "test-a",
    targetTestId: "test-b",
    materialKey: "video|thumbnail|2026-07-10|options"
  }]);
  assert.equal(result.ambiguous.length, 0);
});

test("preserves the identity carrying the reviewer action", () => {
  const result = planExactMaterialReconciliation([
    candidate({ testId: "test-a", status: "result_logged" }),
    candidate({ testId: "test-b", activeActions: ["B"] })
  ]);
  assert.equal(result.mappings[0].targetTestId, "test-b");
});

test("refuses conflicting explicit outcomes", () => {
  const result = planExactMaterialReconciliation([
    candidate({ testId: "test-a", result: "winner", resultEvidence: "sheet_explicit", explicitWinnerVariant: "A" }),
    candidate({ testId: "test-b", result: "winner", resultEvidence: "studio_explicit", explicitWinnerVariant: "B" })
  ]);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.ambiguous[0].reason, "conflicting_explicit_results");
});

test("refuses conflicting reviewer actions", () => {
  const result = planExactMaterialReconciliation([
    candidate({ testId: "test-a", activeActions: ["A"] }),
    candidate({ testId: "test-b", activeActions: ["B"] })
  ]);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.ambiguous[0].reason, "conflicting_reviewer_actions");
});
