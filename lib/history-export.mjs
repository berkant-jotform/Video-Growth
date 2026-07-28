import crypto from "node:crypto";

export const HISTORY_EXPORT_SCHEMA_VERSION = "1.0.0";
export const HISTORY_EXPORT_WIDER_THRESHOLD_DAYS = 21;
export const HISTORY_EXPORT_ROWS = Object.freeze(["current_view", "all_completed", "everything"]);
export const HISTORY_EXPORT_CONTENTS = Object.freeze(["workbook", "workbook_audit"]);
export const EXPORT_RESULT_VALUES = Object.freeze([
  "winner",
  "performed_same",
  "inconclusive",
  "cancelled",
  "running",
  "unknown"
]);

const EXPLICIT_EVIDENCE = new Set(["studio_explicit", "sheet_explicit"]);
const TERMINAL_RESULTS = new Set(["winner", "performed_same", "inconclusive", "cancelled"]);
const YOUTUBE_EARLIEST_DATE = "2005-02-14";

export function normalizeHistoryExportRequest(input = {}) {
  const filters = input.filters || {};
  const rows = HISTORY_EXPORT_ROWS.includes(input.rows) ? input.rows : "current_view";
  const contents = HISTORY_EXPORT_CONTENTS.includes(input.contents)
    ? input.contents
    : "workbook";
  return {
    rows,
    contents,
    includeReviewerNotes: Boolean(input.includeReviewerNotes),
    filters: {
      search: clean(filters.search, 160),
      channel: clean(filters.channel, 120) || "all",
      action: clean(filters.action, 80) || "all",
      testType: ["title", "thumbnail"].includes(filters.testType)
        ? filters.testType
        : "all"
    }
  };
}

export function buildHistoryExport({
  source,
  request,
  actorName = "Reviewer",
  generatedAtUtc = new Date().toISOString()
}) {
  const normalized = normalizeHistoryExportRequest(request);
  const selectedTests = selectTests(source, normalized);
  const selectedIds = new Set(selectedTests.map((test) => test.testId));
  const sourceRecords = (source.sourceRecords || []).filter((item) =>
    selectedIds.has(item.testId)
  );
  const actions = (source.actions || []).filter((item) => selectedIds.has(item.testId));
  const finishSignals = (source.finishSignals || []).filter((item) =>
    selectedIds.has(item.testId)
  );
  const videoIds = new Set(selectedTests.map((test) => test.videoId).filter(Boolean));
  const videoContexts = (source.videoContexts || []).filter((item) =>
    videoIds.has(item.videoId)
  );
  const sourceByTest = groupBy(sourceRecords, (item) => item.testId);
  const actionsByTest = groupBy(actions, (item) => item.testId);
  const eventsByTest = groupBy(finishSignals, (item) => item.testId);
  const contextByVideo = new Map(videoContexts.map((item) => [item.videoId, item]));

  const tests = selectedTests.map((test) => testDatasetRow({
    test,
    sourceRows: sourceByTest.get(test.testId) || [],
    actions: actionsByTest.get(test.testId) || [],
    events: eventsByTest.get(test.testId) || [],
    videoContext: contextByVideo.get(test.videoId) || null,
    generatedAtUtc
  }));
  const testsById = new Map(tests.map((test) => [test.test_id, test]));
  const variants = selectedTests.flatMap((test) =>
    variantDatasetRows(test, testsById.get(test.testId))
  );
  const actionRows = actions.map((action) =>
    actionDatasetRow(action, normalized.includeReviewerNotes)
  );
  const signalRows = finishSignals.map(finishSignalDatasetRow);
  const sourceRows = sourceRecords.map(sourceRecordDatasetRow);
  const contextRows = videoContexts.map(videoContextDatasetRow);
  const qualityRows = tests.map((test) => dataQualityDatasetRow(test));
  const coverage = computeCoverage({
    tests,
    generatedAtUtc
  });
  const preview = buildPreview({
    source,
    normalized,
    tests,
    variants,
    actions: actionRows,
    signals: signalRows,
    sourceRecords: sourceRows,
    coverage,
    generatedAtUtc
  });
  const identity = {
    exportSchemaVersion: HISTORY_EXPORT_SCHEMA_VERSION,
    generatedAtUtc,
    generatedBy: actorName,
    authorizationScope: "shared_workspace_authenticated",
    rows: normalized.rows,
    contents: normalized.contents,
    includeReviewerNotes: normalized.includeReviewerNotes,
    filters: normalized.filters,
    requestHash: requestHash(normalized)
  };
  return {
    identity,
    preview,
    coverage,
    datasets: {
      tests,
      variants,
      actions: actionRows,
      finishSignals: signalRows,
      videoContext: contextRows,
      dataQuality: qualityRows,
      sourceRecords: sourceRows,
      scanHistory: (source.scanHistory || []).map(scanHistoryDatasetRow),
      idHistory: (source.idHistory || [])
        .filter((item) => selectedIds.has(item.testId))
        .map(idHistoryDatasetRow),
      aliases: (source.aliases || [])
        .filter((item) => selectedIds.has(item.testId))
        .map(aliasDatasetRow)
    }
  };
}

export function computeCoverage({ tests = [], generatedAtUtc = new Date().toISOString() }) {
  const sheetBacked = tests.filter((test) => !isAppManagedSourceKind(test.source_kind));
  const appManaged = tests.filter((test) => isAppManagedSourceKind(test.source_kind));
  const strictEligible = sheetBacked.filter((test) => test.lifecycle_status === "finished");
  const overThreeWeeks = sheetBacked.filter(
    (test) =>
      test.lifecycle_status === "unknown" &&
      test.data_quality_flag === "missing_finish_evidence" &&
      ageDays(test.start_date, generatedAtUtc) >= HISTORY_EXPORT_WIDER_THRESHOLD_DAYS
  );
  const widerEligible = [...strictEligible, ...overThreeWeeks];
  const metrics = {
    resultEvidence: (test) => EXPLICIT_EVIDENCE.has(test.result_evidence),
    sharesPresent: (test) => Boolean(test.share_present),
    strictShares: (test) =>
      test.test_type === "title" &&
      test.configured_variant_count >= 2 &&
      Boolean(test.share_sum_valid)
  };
  const strict = coverageRows(strictEligible, metrics, "strict_terminal_evidence");
  const wider = coverageRows(widerEligible, metrics, "terminal_plus_over_three_weeks");
  const resultDistribution = countBy(tests, (test) => test.result || "unknown");
  const inconclusive = tests.filter((test) => test.result === "inconclusive");
  const reasonCount = inconclusive.filter((test) => test.inconclusive_reason).length;
  const channel = coverageByDimension(widerEligible, "channel", metrics);
  const period = coverageByDimension(widerEligible, "start_month", metrics);
  const bias = sharePresenceBias(tests);
  return {
    population: {
      selectedLogicalTests: tests.length,
      sheetBackedLogicalTests: sheetBacked.length,
      appManagedLogicalTests: appManaged.length,
      strictEligibleN: strictEligible.length,
      widerEligibleN: widerEligible.length,
      strictDenominatorType: "strict_terminal_evidence",
      widerDenominatorType: "terminal_plus_over_three_weeks"
    },
    widerThresholdDays: HISTORY_EXPORT_WIDER_THRESHOLD_DAYS,
    widerThresholdRule: "stored_start_age_days_greater_than_or_equal_to_threshold",
    strict,
    wider,
    overThreeWeeksCount: overThreeWeeks.length,
    resultDistribution,
    inconclusiveReason: aggregateMetric({
      key: "inconclusive_reason_coverage",
      label: "Inconclusive reason coverage",
      eligible: inconclusive.length,
      included: reasonCount
    }),
    authoritativeWinnerCount: tests.filter(
      (test) =>
        test.result === "winner" &&
        EXPLICIT_EVIDENCE.has(test.result_evidence)
    ).length,
    channel,
    period,
    bias: sharePresenceBias(sheetBacked)
  };
}

export function coverageBand(rate) {
  if (!Number.isFinite(rate)) return "unknown";
  if (rate < 0.4) return "low";
  if (rate <= 0.6) return "partial";
  return "good";
}

export function historyExportFilename({ tests = [], filters = {}, generatedAtUtc, requestHash: hash }) {
  const channel =
    filters.channel && filters.channel !== "all"
      ? filePart(filters.channel)
      : "All_Channels";
  const dates = tests
    .flatMap((test) => [test.start_date, test.finish_date])
    .filter((value) => isCredibleExportDate(value))
    .sort();
  const start = dates[0] || "No_Date";
  const end = dates.at(-1) || String(generatedAtUtc || "").slice(0, 10) || "No_Date";
  return `YT_AB_Tests_${channel}_${start}_${end}_${String(hash || "").slice(0, 6)}.xlsx`;
}

export function safeSpreadsheetText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "");
}

function selectTests(source, request) {
  const actionsByTest = groupBy(source.actions || [], (item) => item.testId);
  return (source.tests || []).filter((test) => {
    const actions = actionsByTest.get(test.testId) || [];
    if (request.rows === "current_view" && !actions.length) return false;
    if (
      request.rows === "all_completed" &&
      test.lifecycleStatus !== "finished" &&
      !actions.some((item) => !item.undoneAt)
    ) {
      return false;
    }
    if (
      request.filters.channel !== "all" &&
      normalize(test.channel) !== normalize(request.filters.channel)
    ) {
      return false;
    }
    if (
      request.filters.testType !== "all" &&
      test.testType !== request.filters.testType
    ) {
      return false;
    }
    if (
      request.filters.action !== "all" &&
      !actions.some((item) => item.action === request.filters.action)
    ) {
      return false;
    }
    if (request.filters.search) {
      const haystack = normalize([
        test.videoTitle,
        test.currentYoutubeTitle,
        test.videoId,
        test.channel,
        ...actions.flatMap((item) => [item.action, item.actorName])
      ].join(" "));
      if (!haystack.includes(normalize(request.filters.search))) return false;
    }
    return true;
  });
}

function testDatasetRow({
  test,
  sourceRows,
  actions,
  events,
  videoContext,
  generatedAtUtc
}) {
  const share = shareAnalysis(test);
  const duration = durationFields({ test, actions, events, generatedAtUtc });
  const activeActions = actions.filter((item) => !item.undoneAt);
  const latestAction = [...activeActions].sort(byTimeDesc("createdAt"))[0] || null;
  const finishSignal = bestFinishSignal(events);
  const startDate = dateOnly(test.startDate);
  const finishDate = dateOnly(test.finishDate);
  const startDateCredible = isCredibleExportDate(startDate);
  const videoAge =
    videoContext?.publishedAt && startDateCredible
      ? nonNegativeAgeDays(videoContext.publishedAt, `${startDate}T00:00:00.000Z`)
      : null;
  return {
    test_id: test.testId,
    primary_test_run_id: test.primaryTestRunId || "",
    video_id: test.videoId || "",
    channel: test.channel || "",
    test_type: test.testType || "",
    source_kind: test.sourceKind || "",
    video_title: test.videoTitle || test.currentYoutubeTitle || "",
    current_youtube_title: test.currentYoutubeTitle || "",
    lifecycle_status: test.lifecycleStatus || "unknown",
    data_quality_flag: test.dataQualityFlag || "",
    result: test.result || "unknown",
    result_evidence: test.resultEvidence || "unknown",
    result_semantics_version: test.resultSemanticsVersion || "",
    explicit_winner_variant: test.explicitWinnerVariant || "",
    highest_share_variant: share.highestShareVariant,
    highest_share_is_descriptive: Boolean(share.highestShareVariant),
    operational_decision: latestAction?.action || test.operationalDecision || "",
    youtube_applied_variant: test.youtubeAppliedVariant || "",
    inconclusive_reason: test.inconclusiveReason || "",
    inconclusive_reason_evidence: test.inconclusiveReasonEvidence || "",
    start_date: startDate,
    start_date_quality: dateQuality(startDate),
    start_month: startDateCredible ? startDate.slice(0, 7) : startDate ? "Invalid date" : "Unknown",
    finish_date: finishDate,
    finish_date_quality: dateQuality(finishDate),
    finish_signal_at_utc: iso(finishSignal?.occurredAt || finishSignal?.observedAt),
    finish_source: finishSignal?.source || (test.finishDate ? "sheet" : ""),
    source_record_count: sourceRows.length,
    configured_variant_count: share.configuredVariantCount,
    exported_variant_count: share.exportedVariantCount,
    variant_data_quality: share.variantDataQuality,
    populated_share_count: share.populatedShareCount,
    share_present: share.sharePresent,
    share_sum: share.shareSum,
    share_sum_valid: share.shareSumValid,
    share_quality: share.quality,
    possible_retest: Boolean(test.possibleRetest),
    previous_test_id: test.previousTestId || "",
    drifted: Boolean(test.driftedAt),
    drift_reason: test.driftReason || "",
    active_action_count: activeActions.length,
    all_action_count: actions.length,
    finish_signal_count: events.length,
    video_age_at_test_start_days: videoAge,
    ...duration
  };
}

function variantDatasetRows(test, exportedTest) {
  const options = test.options || {};
  const shares = test.watchTimeShare || {};
  const previews = test.thumbnailPreviews || {};
  return ["A", "B", "C"]
    .filter((slot) => hasVariantEvidence({
      option: options[slot],
      preview: previews[slot],
      share: shares[slot]
    }))
    .map((slot) => ({
      test_id: test.testId,
      video_id: test.videoId || "",
      channel: test.channel || "",
      test_type: test.testType || "",
      variant_slot: slot,
      variant_text: optionText(options[slot]),
      thumbnail_ref: optionThumbnail(options[slot]) || previews[slot] || "",
      watch_time_share: numericShare(shares[slot]),
      variant_content_present:
        hasConfiguredOption(options[slot]) || hasConfiguredOption(previews[slot]),
      variant_evidence: variantEvidence({
        option: options[slot],
        preview: previews[slot],
        share: shares[slot]
      }),
      is_youtube_winner:
        exportedTest.result === "winner" &&
        exportedTest.explicit_winner_variant === slot,
      is_highest_share_descriptive: exportedTest.highest_share_variant === slot,
      is_operational_decision: exportedTest.operational_decision === slot,
      share_included_in_strict_analysis:
        exportedTest.test_type === "title" &&
        exportedTest.configured_variant_count >= 2 &&
        Boolean(exportedTest.share_sum_valid)
    }));
}

function actionDatasetRow(action, includeNotes) {
  return {
    action_id: action.actionId,
    test_id: action.testId,
    test_run_id: action.testRunId || "",
    action: action.action || "",
    actor_name: action.actorName || "",
    created_at_utc: iso(action.createdAt),
    created_at_europe_istanbul: istanbulIso(action.createdAt),
    undone_at_utc: iso(action.undoneAt),
    undone_by: action.undoneBy || "",
    active_for_analysis: !action.undoneAt,
    reviewer_note_included: includeNotes,
    reviewer_note: includeNotes ? action.note || "" : ""
  };
}

function finishSignalDatasetRow(event) {
  return {
    event_id: event.eventId,
    test_id: event.testId || "",
    test_run_id: event.testRunId || "",
    video_id: event.videoId || "",
    channel: event.channel || "",
    source: event.source || "",
    raw_text: event.rawText || "",
    detection_confidence: event.matchedConfidence || "",
    processing_status: event.processingStatus || "",
    result: event.result || "unknown",
    result_evidence: event.resultEvidence || "unknown",
    explicit_winner_variant: event.explicitWinnerVariant || "",
    inconclusive_reason: event.inconclusiveReason || "",
    occurred_at_utc: iso(event.occurredAt),
    observed_at_utc: iso(event.observedAt),
    active_for_analysis: ["matched", "superseded"].includes(event.processingStatus)
  };
}

function sourceRecordDatasetRow(record) {
  return {
    test_run_id: record.testRunId,
    test_id: record.testId || "",
    video_id: record.videoId || "",
    source_kind: record.sourceKind || "",
    spreadsheet_id: record.spreadsheetId || "",
    sheet_name: record.sheetName || "",
    row_number: numberOrBlank(record.rowNumber),
    status: record.status || "",
    start_date: dateOnly(record.startDate),
    finish_date: dateOnly(record.finishDate),
    option_fingerprint: record.optionFingerprint || "",
    content_hash: record.contentHash || "",
    last_seen_scan_id: record.lastSeenScanId || "",
    updated_at_utc: iso(record.updatedAt)
  };
}

function videoContextDatasetRow(context) {
  return {
    video_id: context.videoId,
    published_at_utc: iso(context.publishedAt),
    definition: context.definition || "",
    duration_seconds: numberOrBlank(context.durationSeconds),
    live_archive: Boolean(context.liveArchive),
    made_for_kids: booleanOrBlank(context.madeForKids),
    privacy_status: context.privacyStatus || "",
    context_fetched_at_utc: iso(context.contextFetchedAt)
  };
}

function dataQualityDatasetRow(test) {
  const issues = [];
  if (!test.video_id) issues.push("missing_video_id");
  if (!test.start_date) issues.push("missing_start_date");
  if (test.data_quality_flag) issues.push(test.data_quality_flag);
  if (!EXPLICIT_EVIDENCE.has(test.result_evidence)) issues.push("result_evidence_missing");
  if (test.share_present && !test.share_sum_valid) issues.push(`shares_${test.share_quality}`);
  if (test.start_date_quality === "invalid_pre_youtube") issues.push("start_date_before_youtube");
  if (test.finish_date_quality === "invalid_pre_youtube") issues.push("finish_date_before_youtube");
  if (test.exported_variant_count === 0) issues.push("missing_variant_rows");
  if (test.exported_variant_count === 1) issues.push("incomplete_variant_set");
  if (test.exported_variant_count > test.configured_variant_count) {
    issues.push("variant_content_missing");
  }
  if (test.drifted) issues.push("sheet_drift");
  if (test.possible_retest && !test.previous_test_id) issues.push("retest_chain_missing");
  return {
    test_id: test.test_id,
    video_id: test.video_id,
    channel: test.channel,
    test_type: test.test_type,
    lifecycle_status: test.lifecycle_status,
    data_quality_flag: test.data_quality_flag,
    result_evidence_present: EXPLICIT_EVIDENCE.has(test.result_evidence),
    share_present: test.share_present,
    share_sum_valid: test.share_sum_valid,
    share_quality: test.share_quality,
    configured_variant_count: test.configured_variant_count,
    exported_variant_count: test.exported_variant_count,
    variant_data_quality: test.variant_data_quality,
    variant_content_missing_count:
      Math.max(0, test.exported_variant_count - test.configured_variant_count),
    source_record_count: test.source_record_count,
    possible_retest: test.possible_retest,
    drifted: test.drifted,
    issue_count: issues.length,
    issue_codes: issues.join(";")
  };
}

function scanHistoryDatasetRow(scan) {
  return {
    scan_id: scan.scanId,
    status: scan.status || "",
    actor_name: scan.actorName || "",
    started_at_utc: iso(scan.startedAt),
    completed_at_utc: iso(scan.completedAt),
    warnings_count: Array.isArray(scan.warnings) ? scan.warnings.length : 0,
    summary_json: JSON.stringify(scan.summary || {}),
    counts_json: JSON.stringify(scan.counts || {})
  };
}

function idHistoryDatasetRow(item) {
  return {
    history_id: item.historyId,
    test_id: item.testId,
    test_run_id: item.testRunId || "",
    event_type: item.eventType || "",
    old_value_json: JSON.stringify(item.oldValue || {}),
    new_value_json: JSON.stringify(item.newValue || {}),
    reason: item.reason || "",
    migration_id: item.migrationId || "",
    created_at_utc: iso(item.createdAt)
  };
}

function aliasDatasetRow(item) {
  return {
    alias_id: item.aliasId,
    test_id: item.testId,
    alias_type: item.aliasType || "",
    alias_value: item.aliasValue || "",
    active: Boolean(item.active),
    first_seen_at_utc: iso(item.firstSeenAt),
    last_seen_at_utc: iso(item.lastSeenAt)
  };
}

function buildPreview({
  source,
  normalized,
  tests,
  variants,
  actions,
  signals,
  sourceRecords,
  coverage,
  generatedAtUtc
}) {
  const warnings = [];
  const latestScan = source.scanHistory?.[0] || null;
  if (!tests.length) {
    warnings.push(warning("blocking", "No tests match this scope.", "change_scope"));
  }
  const incompleteIdentity = tests.filter(
    (test) => !test.test_id || !test.result_semantics_version
  ).length;
  if (incompleteIdentity) {
    warnings.push(
      warning(
        "blocking",
        `${incompleteIdentity} tests are missing migrated identity or result semantics.`,
        "refresh_sources"
      )
    );
  }
  const latestWarnings = latestScan?.warnings || [];
  if (latestWarnings.length) {
    warnings.push(
      warning(
        "degrading",
        "The latest scan used cached or incomplete source data.",
        "refresh_sources"
      )
    );
  }
  if (coverage.wider.find((item) => item.key === "strict_shares")?.band === "low") {
    warnings.push(
      warning(
        "degrading",
        "Strict watch-time-share coverage is below 40% under the wider denominator.",
        "change_scope"
      )
    );
  }
  const missingVariants = tests.filter((test) => test.exported_variant_count === 0).length;
  const singleVariants = tests.filter((test) => test.exported_variant_count === 1).length;
  if (missingVariants || singleVariants) {
    warnings.push(
      warning(
        "degrading",
        `${missingVariants} tests have no exportable A/B/C variant evidence and ${singleVariants} have only one variant. See Data Quality for exact test IDs.`,
        "change_scope"
      )
    );
  }
  const drift = tests.filter((test) => test.drifted).length;
  if (drift) {
    warnings.push(
      warning("informational", `${drift} tests changed after first capture.`, "review_conflicts")
    );
  }
  const retests = tests.filter((test) => test.possible_retest).length;
  if (retests) {
    warnings.push(
      warning("informational", `${retests} possible retests are included.`, "change_scope")
    );
  }
  const invalidDates = tests.filter(
    (test) =>
      test.start_date_quality === "invalid_pre_youtube" ||
      test.finish_date_quality === "invalid_pre_youtube"
  ).length;
  if (invalidDates) {
    warnings.push(
      warning(
        "degrading",
        `${invalidDates} tests contain a stored date from before YouTube existed. Those values remain in the audit data but are excluded from date spans and duration metrics.`,
        "refresh_sources"
      )
    );
  }
  const dates = tests.flatMap((test) =>
    [test.start_date, test.finish_date, test.finish_signal_at_utc?.slice(0, 10)].filter(Boolean)
  ).filter((value) => isCredibleExportDate(value)).sort();
  return {
    logicalTests: tests.length,
    sourceRecords: sourceRecords.length,
    variants: variants.length,
    sharesPresent: tests.filter((test) => test.share_present).length,
    shareCoverage: tests.length
      ? tests.filter((test) => test.share_present).length / tests.length
      : null,
    actions: actions.length,
    signals: signals.length,
    dateSpan: {
      start: dates[0] || "",
      end: dates.at(-1) || ""
    },
    missingCoverageByChannel: coverage.channel,
    missingCoverageByPeriod: coverage.period,
    coveragePopulation: coverage.population,
    strictCoverage: coverage.strict,
    widerCoverage: coverage.wider,
    overThreeWeeksCount: coverage.overThreeWeeksCount,
    warnings,
    blocking: warnings.some((item) => item.level === "blocking"),
    generatedAtUtc,
    rows: normalized.rows,
    contents: normalized.contents,
    requestHash: requestHash(normalized)
  };
}

function coverageRows(eligibleTests, metrics, denominatorType) {
  return Object.entries(metrics).map(([key, predicate]) => {
    const included = eligibleTests.filter(predicate).length;
    return {
      ...aggregateMetric({
        key: camelToSnake(key),
        label: coverageLabel(key),
        eligible: eligibleTests.length,
        included
      }),
      denominatorType
    };
  });
}

function aggregateMetric({ key, label, eligible, included }) {
  const rate = eligible ? included / eligible : null;
  return {
    key,
    label,
    value: included,
    eligibleN: eligible,
    includedN: included,
    coverageRate: rate,
    band: coverageBand(rate)
  };
}

function coverageByDimension(tests, field, metrics) {
  const grouped = groupBy(tests, (test) => test[field] || "Unknown");
  return Array.from(grouped.entries())
    .map(([value, items]) => {
      const resultEvidence = items.filter(metrics.resultEvidence).length;
      const sharesPresent = items.filter(metrics.sharesPresent).length;
      const strictShares = items.filter(metrics.strictShares).length;
      return {
        dimension: value,
        eligibleN: items.length,
        resultEvidenceN: resultEvidence,
        resultEvidenceRate: items.length ? resultEvidence / items.length : null,
        sharesPresentN: sharesPresent,
        sharesPresentRate: items.length ? sharesPresent / items.length : null,
        strictSharesN: strictShares,
        strictSharesRate: items.length ? strictShares / items.length : null,
        strictSharesBand: coverageBand(items.length ? strictShares / items.length : null)
      };
    })
    .sort((left, right) => right.eligibleN - left.eligibleN || left.dimension.localeCompare(right.dimension));
}

function sharePresenceBias(tests) {
  const findings = [];
  for (const [channel, channelTests] of groupBy(tests, (test) => test.channel || "Unknown")) {
    const withShares = channelTests.filter((test) => test.share_present);
    const withoutShares = channelTests.filter((test) => !test.share_present);
    if (withShares.length < 20 || withoutShares.length < 20) continue;
    const distributionA = distribution(withShares);
    const distributionB = distribution(withoutShares);
    const distance =
      EXPORT_RESULT_VALUES.reduce(
        (sum, value) => sum + Math.abs((distributionA[value] || 0) - (distributionB[value] || 0)),
        0
      ) / 2;
    findings.push({
      channel,
      withSharesN: withShares.length,
      withoutSharesN: withoutShares.length,
      totalVariationDistance: distance,
      material: distance >= 0.15
    });
  }
  return {
    decisionRule:
      "Material when both groups have at least 20 tests and total variation distance is at least 0.15.",
    findings,
    material: findings.some((item) => item.material)
  };
}

function distribution(tests) {
  const total = tests.length || 1;
  return Object.fromEntries(
    EXPORT_RESULT_VALUES.map((value) => [
      value,
      tests.filter((test) => test.result === value).length / total
    ])
  );
}

function durationFields({ test, actions, events, generatedAtUtc }) {
  const start = dayBounds(test.startDate, { credibleOnly: true });
  const finishSignal = bestFinishSignal(events);
  const finish = timestampBounds(finishSignal?.occurredAt) ||
    dayBounds(test.finishDate, { credibleOnly: true });
  const detection = timestampBounds(finishSignal?.observedAt);
  const firstAction = [...actions]
    .filter((item) => !item.undoneAt && item.createdAt)
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))[0];
  const action = timestampBounds(firstAction?.createdAt);
  const testDuration = boundedDuration(start, finish, start && finish
    ? finishSignal?.occurredAt
      ? "bounded_sheet_start"
      : "sheet_dates"
    : "");
  const detectionDelay = boundedDuration(
    timestampBounds(finishSignal?.occurredAt),
    detection,
    finishSignal?.occurredAt && finishSignal?.observedAt ? "exact" : ""
  );
  const reviewResponse = boundedDuration(
    finish,
    action,
    finish && action
      ? finishSignal?.occurredAt ? "bounded_finish" : "sheet_finish_date"
      : ""
  );
  const totalCycle = boundedDuration(
    start,
    action,
    start && action ? "bounded_sheet_start" : ""
  );
  const isOpen = test.lifecycleStatus !== "finished" && start;
  const openDays = isOpen ? ageDays(dateOnly(test.startDate), generatedAtUtc) : null;
  return {
    test_duration_hours: testDuration.value,
    test_duration_quality: testDuration.quality,
    test_duration_earliest_hours: testDuration.earliest,
    test_duration_latest_hours: testDuration.latest,
    detection_delay_hours: detectionDelay.value,
    detection_delay_quality: detectionDelay.quality,
    detection_delay_earliest_hours: detectionDelay.earliest,
    detection_delay_latest_hours: detectionDelay.latest,
    review_response_hours: reviewResponse.value,
    review_response_quality: reviewResponse.quality,
    review_response_earliest_hours: reviewResponse.earliest,
    review_response_latest_hours: reviewResponse.latest,
    total_cycle_hours: totalCycle.value,
    total_cycle_quality: totalCycle.quality,
    total_cycle_earliest_hours: totalCycle.earliest,
    total_cycle_latest_hours: totalCycle.latest,
    days_open: Number.isFinite(openDays) ? openDays : null,
    days_open_quality: Number.isFinite(openDays) ? "sheet_date_as_of" : "",
    days_open_earliest_days: Number.isFinite(openDays) ? openDays : null,
    days_open_latest_days: Number.isFinite(openDays) ? openDays + 1 : null,
    days_open_as_of_utc: Number.isFinite(openDays) ? generatedAtUtc : ""
  };
}

function boundedDuration(start, end, quality) {
  if (!start || !end || !quality) return emptyDuration();
  const earliest = Math.max(0, (end.earliest - start.latest) / 3_600_000);
  const latest = Math.max(0, (end.latest - start.earliest) / 3_600_000);
  const value = quality === "exact" ? earliest : (earliest + latest) / 2;
  return {
    value: round(value, 4),
    quality,
    earliest: round(earliest, 4),
    latest: round(latest, 4)
  };
}

function emptyDuration() {
  return { value: null, quality: "", earliest: null, latest: null };
}

function dayBounds(value, { credibleOnly = false } = {}) {
  const day = dateOnly(value);
  if (!day || (credibleOnly && !isCredibleExportDate(day))) return null;
  const earliest = new Date(`${day}T00:00:00.000Z`).valueOf();
  if (Number.isNaN(earliest)) return null;
  return { earliest, latest: earliest + 86_400_000 };
}

function timestampBounds(value) {
  if (!value) return null;
  const time = new Date(value).valueOf();
  if (Number.isNaN(time)) return null;
  return { earliest: time, latest: time };
}

function bestFinishSignal(events) {
  return [...events]
    .filter(
      (event) =>
        event.source !== "metadata" &&
        (TERMINAL_RESULTS.has(event.result) || event.resultEvidence === "studio_explicit")
    )
    .sort((left, right) => {
      const explicit = Number(EXPLICIT_EVIDENCE.has(right.resultEvidence)) -
        Number(EXPLICIT_EVIDENCE.has(left.resultEvidence));
      if (explicit) return explicit;
      return new Date(right.occurredAt || right.observedAt || 0) -
        new Date(left.occurredAt || left.observedAt || 0);
    })[0] || null;
}

function shareAnalysis(test) {
  const options = test.options || {};
  const shares = test.watchTimeShare || {};
  const previews = test.thumbnailPreviews || {};
  const configured = ["A", "B", "C"].filter(
    (slot) =>
      hasConfiguredOption(options[slot]) ||
      hasConfiguredOption(previews[slot])
  );
  const exported = ["A", "B", "C"].filter((slot) =>
    hasVariantEvidence({
      option: options[slot],
      preview: previews[slot],
      share: shares[slot]
    })
  );
  const numeric = exported
    .map((slot) => [slot, numericShare(shares[slot])])
    .filter(([, value]) => Number.isFinite(value));
  const complete = exported.length >= 2 && numeric.length === exported.length;
  const sum = complete ? numeric.reduce((total, [, value]) => total + value, 0) : null;
  const valid = complete && Math.abs(sum - 1) <= 0.01;
  const sorted = [...numeric].sort((left, right) => right[1] - left[1]);
  const highest =
    sorted.length &&
    !(sorted[1] && Math.abs(sorted[0][1] - sorted[1][1]) < 0.000001)
      ? sorted[0][0]
      : "";
  return {
    configuredVariantCount: configured.length,
    exportedVariantCount: exported.length,
    variantDataQuality:
      exported.length === 0
        ? "missing"
        : exported.length === 1
          ? "incomplete"
          : configured.length < exported.length
            ? "content_missing"
            : "complete",
    populatedShareCount: numeric.length,
    sharePresent: numeric.length > 0,
    shareSum: sum,
    shareSumValid: valid,
    highestShareVariant: test.highestShareVariant || highest,
    quality:
      exported.length < 2
        ? "configured_variants_unknown"
        : !complete
          ? "incomplete"
          : valid
            ? "valid"
            : "invalid_sum"
  };
}

function requestHash(request) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(request), "utf8")
    .digest("hex");
}

function warning(level, message, action) {
  return { level, message, action };
}

function coverageLabel(key) {
  return {
    resultEvidence: "Explicit result evidence",
    sharesPresent: "Watch-time shares present",
    strictShares: "Strictly validated shares"
  }[key] || key;
}

function hasConfiguredOption(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim() !== "";
}

function hasVariantEvidence({ option, preview, share }) {
  return (
    hasConfiguredOption(option) ||
    hasConfiguredOption(preview) ||
    Number.isFinite(numericShare(share))
  );
}

function variantEvidence({ option, preview, share }) {
  const evidence = [];
  if (hasConfiguredOption(option)) evidence.push("configured_option");
  if (hasConfiguredOption(preview)) evidence.push("thumbnail_preview");
  if (Number.isFinite(numericShare(share))) evidence.push("watch_time_share");
  return evidence.join("+");
}

function optionText(value) {
  if (value && typeof value === "object") {
    return safeSpreadsheetText(value.text || value.title || value.label || "");
  }
  return safeSpreadsheetText(value);
}

function optionThumbnail(value) {
  if (!value || typeof value !== "object") return "";
  return safeSpreadsheetText(value.url || value.thumbnailUrl || value.imageUrl || "");
}

function numericShare(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function ageDays(start, end) {
  const startTime = new Date(String(start || "").length === 10 ? `${start}T00:00:00.000Z` : start).valueOf();
  const endTime = new Date(end).valueOf();
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return -1;
  return Math.floor((endTime - startTime) / 86_400_000);
}

function nonNegativeAgeDays(start, end) {
  const age = ageDays(start, end);
  return age >= 0 ? age : null;
}

function dateQuality(value) {
  if (!value) return "missing";
  return isCredibleExportDate(value) ? "source_date" : "invalid_pre_youtube";
}

function isCredibleExportDate(value) {
  const day = dateOnly(value);
  return Boolean(day && day >= YOUTUBE_EARLIEST_DATE);
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10);
}

function iso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function istanbulIso(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  const offset = String(parts.timeZoneName || "GMT+03:00").replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function byTimeDesc(field) {
  return (left, right) => new Date(right[field] || 0) - new Date(left[field] || 0);
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  return groups;
}

function countBy(items, keyFn) {
  return Object.fromEntries(
    Array.from(groupBy(items, keyFn), ([key, values]) => [key, values.length])
  );
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAppManagedSourceKind(value) {
  return ["app", "app_registry"].includes(String(value || "").trim().toLowerCase());
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function filePart(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "All_Channels";
}

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function numberOrBlank(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function booleanOrBlank(value) {
  return typeof value === "boolean" ? value : "";
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
