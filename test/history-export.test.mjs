import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryExport,
  coverageBand,
  HISTORY_EXPORT_WIDER_THRESHOLD_DAYS,
  normalizeHistoryExportRequest
} from "../lib/history-export.mjs";

test("history export keeps sheet and app grains separate and computes both denominators", () => {
  const exportData = buildHistoryExport({
    source: fixtureSource(),
    request: { rows: "everything", contents: "workbook" },
    actorName: "BG",
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });

  assert.equal(exportData.datasets.tests.length, 4);
  assert.equal(exportData.datasets.sourceRecords.length, 5);
  assert.deepEqual(exportData.coverage.population, {
    selectedLogicalTests: 4,
    sheetBackedLogicalTests: 3,
    appManagedLogicalTests: 1,
    strictEligibleN: 1,
    widerEligibleN: 2,
    strictDenominatorType: "strict_terminal_evidence",
    widerDenominatorType: "terminal_plus_over_three_weeks"
  });
  assert.equal(exportData.coverage.overThreeWeeksCount, 1);
  assert.equal(exportData.coverage.strict[0].eligibleN, 1);
  assert.equal(exportData.coverage.wider[0].eligibleN, 2);
  assert.equal(exportData.coverage.period.some((item) => item.dimension === "2026-06"), true);
});

test("production logical source kinds classify title and thumbnail as sheet-backed", () => {
  const source = fixtureSource();
  source.tests[0] = { ...source.tests[0], sourceKind: "title" };
  source.tests[1] = { ...source.tests[1], sourceKind: "title" };
  source.tests[2] = { ...source.tests[2], sourceKind: "thumbnail" };
  source.tests[3] = { ...source.tests[3], sourceKind: "app_registry" };
  const exportData = buildHistoryExport({
    source,
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });

  assert.equal(exportData.coverage.population.sheetBackedLogicalTests, 3);
  assert.equal(exportData.coverage.population.appManagedLogicalTests, 1);
  assert.equal(exportData.coverage.population.strictEligibleN, 1);
  assert.equal(exportData.coverage.population.widerEligibleN, 2);
});

test("wider coverage includes missing-finish tests exactly twenty-one days old", () => {
  const source = fixtureSource();
  source.tests[1] = {
    ...source.tests[1],
    startDate: "2026-07-07"
  };
  const exportData = buildHistoryExport({
    source,
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });

  assert.equal(HISTORY_EXPORT_WIDER_THRESHOLD_DAYS, 21);
  assert.equal(exportData.coverage.widerThresholdDays, 21);
  assert.equal(exportData.coverage.overThreeWeeksCount, 1);
  assert.equal(exportData.coverage.population.widerEligibleN, 2);
});

test("strict share coverage is title-only and never turns the highest share into a winner", () => {
  const exportData = buildHistoryExport({
    source: fixtureSource(),
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });
  const title = exportData.datasets.tests.find((item) => item.test_id === "test_title");
  const app = exportData.datasets.tests.find((item) => item.test_id === "test_app");
  const strict = exportData.coverage.strict.find((item) => item.key === "strict_shares");

  assert.equal(title.highest_share_variant, "B");
  assert.equal(title.explicit_winner_variant, "");
  assert.equal(title.result, "performed_same");
  assert.equal(strict.includedN, 1);
  assert.equal(app.share_sum_valid, true);
  assert.equal(
    exportData.datasets.variants
      .filter((item) => item.test_id === "test_app")
      .every((item) => item.share_included_in_strict_analysis === false),
    true
  );
});

test("history filters and reviewer-note privacy are enforced in the dataset", () => {
  const source = fixtureSource();
  const request = normalizeHistoryExportRequest({
    rows: "current_view",
    includeReviewerNotes: false,
    filters: {
      channel: "Jotform",
      testType: "title",
      action: "A",
      search: "calendar"
    }
  });
  const exportData = buildHistoryExport({
    source,
    request,
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });

  assert.deepEqual(exportData.datasets.tests.map((item) => item.test_id), ["test_title"]);
  assert.equal(exportData.datasets.actions[0].reviewer_note, "");
  assert.equal(exportData.datasets.actions[0].reviewer_note_included, false);
});

test("coverage bands render 39.9 percent low and 40.1 percent partial", () => {
  assert.equal(coverageBand(0.399), "low");
  assert.equal(coverageBand(0.4), "partial");
  assert.equal(coverageBand(0.401), "partial");
  assert.equal(coverageBand(0.6), "partial");
  assert.equal(coverageBand(0.601), "good");
});

test("share-only A/B slots remain exportable and variant gaps are explicit", () => {
  const source = fixtureSource();
  source.tests[0] = {
    ...source.tests[0],
    options: {},
    thumbnailPreviews: {},
    watchTimeShare: { A: 0.45, B: 0.55 }
  };
  source.tests[1] = {
    ...source.tests[1],
    options: {},
    thumbnailPreviews: {},
    watchTimeShare: {}
  };
  source.tests[2] = {
    ...source.tests[2],
    options: { A: "Only option" },
    thumbnailPreviews: {},
    watchTimeShare: {}
  };
  const exportData = buildHistoryExport({
    source,
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });
  const shareOnly = exportData.datasets.tests.find(
    (item) => item.test_id === "test_title"
  );
  const missing = exportData.datasets.dataQuality.find(
    (item) => item.test_id === "test_old"
  );
  const incomplete = exportData.datasets.dataQuality.find(
    (item) => item.test_id === "test_missing"
  );
  const variants = exportData.datasets.variants.filter(
    (item) => item.test_id === "test_title"
  );

  assert.equal(shareOnly.share_present, true);
  assert.equal(shareOnly.configured_variant_count, 0);
  assert.equal(shareOnly.exported_variant_count, 2);
  assert.equal(shareOnly.variant_data_quality, "content_missing");
  assert.deepEqual(variants.map((item) => item.variant_slot), ["A", "B"]);
  assert.equal(variants.every((item) => item.variant_content_present === false), true);
  assert.equal(
    variants.every((item) => item.variant_evidence === "watch_time_share"),
    true
  );
  assert.equal(
    variants.every((item) => item.share_included_in_strict_analysis === false),
    true
  );
  assert.equal(missing.issue_codes.includes("missing_variant_rows"), true);
  assert.equal(incomplete.issue_codes.includes("incomplete_variant_set"), true);
});

test("duration fields stay numeric or blank and preserve uncertainty bounds", () => {
  const exportData = buildHistoryExport({
    source: fixtureSource(),
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });
  const finished = exportData.datasets.tests.find((item) => item.test_id === "test_title");
  const missing = exportData.datasets.tests.find((item) => item.test_id === "test_missing");

  assert.equal(typeof finished.test_duration_hours, "number");
  assert.equal(typeof finished.review_response_hours, "number");
  assert.equal(finished.test_duration_earliest_hours <= finished.test_duration_latest_hours, true);
  assert.equal(missing.test_duration_hours, null);
  assert.equal(missing.review_response_hours, null);
  assert.equal(missing.days_open, null);
});

test("pre-YouTube source dates stay auditable but do not create duration or date-span claims", () => {
  const source = fixtureSource();
  source.tests[0] = {
    ...source.tests[0],
    startDate: "2001-01-20",
    finishDate: "2001-02-03"
  };
  const exportData = buildHistoryExport({
    source,
    request: { rows: "everything" },
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });
  const testRow = exportData.datasets.tests.find((item) => item.test_id === "test_title");
  const qualityRow = exportData.datasets.dataQuality.find((item) => item.test_id === "test_title");

  assert.equal(testRow.start_date, "2001-01-20");
  assert.equal(testRow.start_date_quality, "invalid_pre_youtube");
  assert.equal(testRow.test_duration_hours, null);
  assert.equal(qualityRow.issue_codes.includes("start_date_before_youtube"), true);
  assert.notEqual(exportData.preview.dateSpan.start, "2001-01-20");
  assert.equal(
    exportData.preview.warnings.some((item) => item.message.includes("before YouTube existed")),
    true
  );
});

function fixtureSource() {
  const base = {
    resultSemanticsVersion: "2026-07-28",
    options: { A: "Original", B: "Alternative" },
    watchTimeShare: { A: 0.4, B: 0.6 },
    thumbnailPreviews: {},
    possibleRetest: false,
    driftReason: ""
  };
  return {
    tests: [
      {
        ...base,
        testId: "test_title",
        primaryTestRunId: "run_title_1",
        videoId: "video_title",
        testType: "title",
        sourceKind: "sheet",
        channel: "Jotform",
        videoTitle: "=Google Calendar guide",
        lifecycleStatus: "finished",
        dataQualityFlag: "",
        result: "performed_same",
        resultEvidence: "studio_explicit",
        startDate: "2026-06-01",
        finishDate: "2026-06-08"
      },
      {
        ...base,
        testId: "test_old",
        primaryTestRunId: "run_old_1",
        videoId: "video_old",
        testType: "title",
        sourceKind: "sheet",
        channel: "AI Agents",
        videoTitle: "Old open test",
        lifecycleStatus: "unknown",
        dataQualityFlag: "missing_finish_evidence",
        result: "unknown",
        resultEvidence: "unknown",
        watchTimeShare: { A: 0.45, B: null },
        startDate: "2026-06-01",
        finishDate: ""
      },
      {
        ...base,
        testId: "test_missing",
        primaryTestRunId: "run_missing_1",
        videoId: "video_missing",
        testType: "thumbnail",
        sourceKind: "sheet",
        channel: "Apps",
        videoTitle: "Missing dates",
        lifecycleStatus: "unknown",
        dataQualityFlag: "missing_start_and_finish_evidence",
        result: "unknown",
        resultEvidence: "unknown",
        startDate: "",
        finishDate: ""
      },
      {
        ...base,
        testId: "test_app",
        primaryTestRunId: "run_app_1",
        videoId: "video_app",
        testType: "thumbnail",
        sourceKind: "app",
        channel: "Jotform",
        videoTitle: "Studio-only test",
        lifecycleStatus: "finished",
        dataQualityFlag: "",
        result: "inconclusive",
        resultEvidence: "studio_explicit",
        startDate: "",
        finishDate: ""
      }
    ],
    sourceRecords: [
      sourceRecord("run_title_1", "test_title", "video_title"),
      sourceRecord("run_title_2", "test_title", "video_title"),
      sourceRecord("run_old_1", "test_old", "video_old"),
      sourceRecord("run_missing_1", "test_missing", "video_missing"),
      { ...sourceRecord("run_app_1", "test_app", "video_app"), sourceKind: "app" }
    ],
    actions: [
      {
        actionId: "action_1",
        testId: "test_title",
        testRunId: "run_title_1",
        action: "A",
        actorName: "BG",
        note: "=private note",
        createdAt: "2026-06-08T12:00:00.000Z",
        undoneAt: "",
        undoneBy: ""
      }
    ],
    finishSignals: [
      {
        eventId: "event_1",
        testId: "test_title",
        testRunId: "run_title_1",
        videoId: "video_title",
        channel: "Jotform",
        source: "studio_bell",
        rawText: "A/B test performed well for all",
        matchedConfidence: "exact",
        processingStatus: "matched",
        result: "performed_same",
        resultEvidence: "studio_explicit",
        occurredAt: "2026-06-08T10:00:00.000Z",
        observedAt: "2026-06-08T10:05:00.000Z"
      },
      {
        eventId: "event_app",
        testId: "test_app",
        testRunId: "run_app_1",
        videoId: "video_app",
        channel: "Jotform",
        source: "studio_bell",
        rawText: "A/B test inconclusive",
        matchedConfidence: "exact",
        processingStatus: "matched",
        result: "inconclusive",
        resultEvidence: "studio_explicit",
        occurredAt: "2026-07-20T10:00:00.000Z",
        observedAt: "2026-07-20T10:01:00.000Z"
      }
    ],
    videoContexts: [
      {
        videoId: "video_title",
        publishedAt: "2026-05-01T10:00:00.000Z",
        definition: "hd",
        durationSeconds: 90,
        liveArchive: false,
        madeForKids: false,
        privacyStatus: "public",
        contextFetchedAt: "2026-07-28T08:00:00.000Z"
      }
    ],
    scanHistory: [
      {
        scanId: "scan_1",
        status: "ok",
        actorName: "BG",
        startedAt: "2026-07-28T08:00:00.000Z",
        completedAt: "2026-07-28T08:01:00.000Z",
        warnings: [],
        summary: {},
        counts: {}
      }
    ],
    idHistory: [],
    aliases: []
  };
}

function sourceRecord(testRunId, testId, videoId) {
  return {
    testRunId,
    testId,
    videoId,
    sourceKind: "sheet",
    spreadsheetId: "sheet_1",
    sheetName: "Tests",
    rowNumber: 2,
    status: "watching",
    startDate: "2026-06-01",
    finishDate: "",
    optionFingerprint: "fingerprint",
    contentHash: "hash",
    lastSeenScanId: "scan_1",
    updatedAt: "2026-07-28T08:00:00.000Z"
  };
}
