import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeShares,
  classifySheetResult,
  classifyStudioResult,
  highestShareDescription,
  projectCanonicalResult,
  RESULT_VALUES,
  resultDisplayLabel
} from "../lib/result-semantics.mjs";

test("result enum storage uses performed_same while UI uses a display label", () => {
  assert.deepEqual(RESULT_VALUES, [
    "winner",
    "performed_same",
    "inconclusive",
    "cancelled",
    "running",
    "unknown"
  ]);
  assert.equal(resultDisplayLabel("performed_same"), "Performed similarly");
  assert.equal(RESULT_VALUES.includes("Performed Similarly"), false);
});

test("numeric shares never become a YouTube winner", () => {
  const projected = projectCanonicalResult({
    detectedOutcome: "winner_b",
    winnerReason: "Highest watch-time share: 55.0%",
    shares: { A: 0.45, B: 0.55 },
    options: { A: "Original", B: "Alternative" }
  });
  assert.equal(projected.result, "unknown");
  assert.equal(projected.resultEvidence, "unknown");
  assert.equal(projected.explicitWinnerVariant, "");
  assert.equal(projected.highestShareVariant, "B");
  assert.match(highestShareDescription(projected.highestShareVariant), /not a YouTube result/i);
});

test("metadata observations remain descriptive in legacy projection", () => {
  const projected = projectCanonicalResult({
    detectedOutcome: "winner_b",
    finishEventSource: "metadata",
    finishEventText: "Applied change observed: option B; current title matches option B."
  });
  assert.equal(projected.result, "unknown");
  assert.equal(projected.explicitWinnerVariant, "");
});

test("Studio labels remain distinct and insufficient views is a reason only", () => {
  const winner = classifyStudioResult(
    "A/B test won Example: We updated your video to use the winner"
  );
  const same = classifyStudioResult(
    "A/B test performed well for all Example: Results with very similar performance"
  );
  const inconclusive = classifyStudioResult(
    "A/B test inconclusive Example: Not enough views to determine a winner"
  );
  assert.equal(winner.result, "winner");
  assert.equal(same.result, "performed_same");
  assert.equal(inconclusive.result, "inconclusive");
  assert.equal(inconclusive.inconclusiveReason, "insufficient_views");
  assert.equal(inconclusive.resultEvidence, "studio_explicit");
});

test("sheet no-clear text is explicit but numeric shares remain descriptive", () => {
  assert.equal(
    classifySheetResult({ shares: { A: "no_clear_winner", B: null } }).result,
    "inconclusive"
  );
  assert.equal(
    classifySheetResult({ shares: { A: 0.49, B: 0.51 } }).result,
    "unknown"
  );
});

test("sheet winner is accepted only from explicit winner text", () => {
  const winnerCell = classifySheetResult({
    shares: { A: "Winner", B: null }
  });
  const winnerText = classifySheetResult({
    rawValues: ["Winner: option C"]
  });
  const numeric = classifySheetResult({
    shares: { A: 0.4, B: 0.6 }
  });
  assert.equal(winnerCell.result, "winner");
  assert.equal(winnerCell.resultEvidence, "sheet_explicit");
  assert.equal(winnerCell.explicitWinnerVariant, "A");
  assert.equal(winnerText.explicitWinnerVariant, "C");
  assert.equal(numeric.result, "unknown");
});

test("share validity uses configured variants and canonical 0-1 totals", () => {
  const valid = analyzeShares({
    shares: { A: 0.3, B: 0.4, C: 0.3 },
    options: { A: "A", B: "B", C: "C" }
  });
  const incomplete = analyzeShares({
    shares: { A: 0.5, B: 0.5 },
    options: { A: "A", B: "B", C: "C" }
  });
  assert.equal(valid.configuredVariantCount, 3);
  assert.equal(valid.shareSumValid, true);
  assert.equal(incomplete.shareSumValid, false);
  assert.equal(incomplete.quality, "incomplete");
});

test("highest share remains descriptive when configured option text is unavailable", () => {
  const analyzed = analyzeShares({
    shares: { A: 0.44, B: 0.56 },
    options: {}
  });
  assert.equal(analyzed.highestShareVariant, "B");
  assert.equal(analyzed.populatedShareCount, 2);
  assert.equal(analyzed.shareSumValid, false);
  assert.equal(analyzed.quality, "configured_variants_unknown");
});
