import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResultMigrationPlan,
  migrationSnapshot,
  verifyRollbackSnapshot
} from "../lib/result-migration.mjs";

function run(overrides = {}) {
  return {
    testRunId: "run-1",
    testId: "",
    videoId: "video-1",
    sourceKind: "title",
    spreadsheetId: "sheet",
    sheetName: "Jotform",
    rowNumber: 2,
    testType: "title",
    channel: "Jotform",
    videoTitle: "Example",
    startDate: "2026-07-01",
    finishDate: "",
    status: "result_logged",
    detectedOutcome: "winner_b",
    suggestedWinner: "B",
    winnerReason: "Highest watch-time share: 55.0%",
    options: { A: "Example", B: "Better example" },
    watchTimeShare: { A: 0.45, B: 0.55 },
    optionFingerprint: "fingerprint",
    ...overrides
  };
}

test("migration downgrades share-only winners and keeps reviewer choices operational", () => {
  const runs = [run()];
  const actions = [{
    actionId: "action-1",
    testRunId: "run-1",
    action: "B",
    createdAt: "2026-07-04T12:00:00.000Z",
    undoneAt: ""
  }];
  const plan = buildResultMigrationPlan({
    runs,
    actions,
    events: [],
    migrationId: "migration-test",
    proposedIds: new Map([["video-1|title|2026-07-01|fingerprint", "test-fixed"]])
  });
  assert.equal(plan.logicalTests[0].result, "unknown");
  assert.equal(plan.logicalTests[0].highestShareVariant, "B");
  assert.equal(plan.logicalTests[0].operationalDecision, "B");
  assert.equal(plan.summary.legacyWinnerRows, 0);
});

test("explicit Studio result overrides legacy share inference", () => {
  const plan = buildResultMigrationPlan({
    runs: [run()],
    events: [{
      eventId: "event-1",
      testRunId: "run-1",
      source: "studio_bell",
      rawText: "A/B test performed well for all Example: Results with very similar performance",
      processingStatus: "matched",
      observedAt: "2026-07-05T12:00:00.000Z"
    }],
    actions: [],
    migrationId: "migration-test",
    proposedIds: new Map([["video-1|title|2026-07-01|fingerprint", "test-fixed"]])
  });
  assert.equal(plan.logicalTests[0].result, "performed_same");
  assert.equal(plan.logicalTests[0].resultEvidence, "studio_explicit");
  assert.equal(plan.logicalTests[0].explicitWinnerVariant, "");
});

test("metadata application remains descriptive and never becomes a winner", () => {
  const plan = buildResultMigrationPlan({
    runs: [run({ watchTimeShare: { A: null, B: null }, status: "running" })],
    events: [{
      eventId: "event-metadata",
      testRunId: "run-1",
      source: "metadata",
      rawText: "Applied change observed: option B",
      detectedOutcome: "applied_b",
      processingStatus: "matched",
      observedAt: "2026-07-05T12:00:00.000Z"
    }],
    actions: [],
    migrationId: "migration-test",
    proposedIds: new Map([["video-1|title|2026-07-01|fingerprint", "test-fixed"]])
  });
  assert.equal(plan.logicalTests[0].result, "unknown");
  assert.equal(plan.logicalTests[0].youtubeAppliedVariant, "B");
  assert.equal(plan.eventUpdates[0].result, "unknown");
  assert.equal(plan.eventUpdates[0].resultEvidence, "unknown");
  assert.equal(plan.eventUpdates[0].youtubeAppliedVariant, "B");
});

test("reviewer choices remain operational and do not invent terminal evidence", () => {
  const plan = buildResultMigrationPlan({
    runs: [run({
      startDate: "",
      watchTimeShare: { A: null, B: null },
      status: "running"
    })],
    events: [],
    actions: [{
      actionId: "action-1",
      testRunId: "run-1",
      action: "A",
      createdAt: "2026-07-04T12:00:00.000Z",
      undoneAt: ""
    }],
    migrationId: "migration-test",
    proposedIds: new Map([["video-1|title||fingerprint", "test-fixed"]])
  });
  assert.equal(plan.logicalTests[0].result, "unknown");
  assert.equal(plan.logicalTests[0].operationalDecision, "A");
  assert.equal(plan.logicalTests[0].lifecycleStatus, "unknown");
  assert.equal(
    plan.logicalTests[0].dataQualityFlag,
    "missing_start_and_finish_evidence"
  );
});

test("unknown lifecycle with a usable start date does not claim the start is missing", () => {
  const plan = buildResultMigrationPlan({
    runs: [run({
      watchTimeShare: { A: null, B: null },
      status: "running"
    })],
    events: [],
    actions: [],
    migrationId: "migration-test",
    proposedIds: new Map([["video-1|title|2026-07-01|fingerprint", "test-fixed"]])
  });
  assert.equal(plan.logicalTests[0].lifecycleStatus, "unknown");
  assert.equal(plan.logicalTests[0].dataQualityFlag, "missing_finish_evidence");
});

test("non-terminal lifecycle flags and wider coverage are reported separately", () => {
  const plan = buildResultMigrationPlan({
    runs: [
      run({
        testRunId: "started-old",
        startDate: "2026-06-01",
        watchTimeShare: { A: null, B: null },
        status: "running"
      }),
      run({
        testRunId: "started-recent",
        videoId: "video-2",
        startDate: "2026-07-20",
        optionFingerprint: "fingerprint-2",
        watchTimeShare: { A: null, B: null },
        status: "running"
      }),
      run({
        testRunId: "no-start",
        videoId: "video-3",
        startDate: "",
        optionFingerprint: "fingerprint-3",
        watchTimeShare: { A: null, B: null },
        status: "running"
      })
    ],
    events: [],
    actions: [],
    migrationId: "migration-test",
    asOfUtc: "2026-07-28T00:00:00.000Z"
  });
  assert.equal(plan.summary.missingFinishCount, 2);
  assert.equal(plan.summary.missingStartAndFinishCount, 1);
  assert.equal(plan.summary.nonTerminalOverThreeWeeksCount, 1);
  assert.equal(
    plan.summary.coverageDenominators.terminalPlusOverThreeWeeks.denominator,
    1
  );
});

test("rollback snapshot verification is checksum exact", () => {
  const source = {
    runs: [run()],
    events: [],
    actions: []
  };
  const before = migrationSnapshot(source);
  const changed = JSON.parse(JSON.stringify(before));
  changed.runs[0].result = "winner";
  assert.equal(verifyRollbackSnapshot(before, changed).exact, false);
  const restored = JSON.parse(JSON.stringify(before));
  const verification = verifyRollbackSnapshot(before, restored);
  assert.equal(verification.exact, true);
  assert.equal(verification.beforeChecksum, verification.restoredChecksum);
});
