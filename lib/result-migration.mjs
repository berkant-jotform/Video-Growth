import crypto from "node:crypto";
import {
  analyzeShares,
  classifySheetResult,
  classifyStudioResult,
  RESULT_SEMANTICS_VERSION
} from "./result-semantics.mjs";
import {
  createTestId,
  identityAliases,
  stableStringify,
  testContentHash
} from "./test-identity.mjs";

const EVIDENCE_PRIORITY = {
  studio_explicit: 40,
  sheet_explicit: 30,
  inferred_legacy: 10,
  unknown: 0
};

export function buildResultMigrationPlan({
  runs = [],
  events = [],
  actions = [],
  migrationId = `result_semantics_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
  asOfUtc = new Date().toISOString(),
  proposedIds = new Map()
} = {}) {
  const sourceRuns = runs.filter((run) => run.sourceKind !== "app_registry");
  const appRuns = runs.filter((run) => run.sourceKind === "app_registry");
  const sheetClusters = clusterRuns(sourceRuns);
  const appClusters = clusterAppRuns(appRuns);
  const allClusters = [...sheetClusters, ...appClusters];
  const clusterByRunId = new Map();
  for (const cluster of allClusters) {
    for (const run of cluster.runs) clusterByRunId.set(run.testRunId, cluster);
  }

  const eventsByCluster = associateEvents({
    clusters: allClusters,
    events,
    clusterByRunId
  });
  const actionsByCluster = associateActions({ actions, clusterByRunId });
  const logicalTests = [];
  const sourceUpdates = [];
  const eventUpdates = [];
  const actionUpdates = [];
  const aliases = [];
  const links = [];
  const idHistory = [];
  const audit = [];

  for (const cluster of allClusters) {
    const clusterEvents = eventsByCluster.get(cluster.key) || [];
    const clusterActions = actionsByCluster.get(cluster.key) || [];
    const representative = chooseRepresentative(cluster.runs);
    const existingIds = Array.from(new Set(cluster.runs.map((run) => run.testId).filter(Boolean)));
    if (existingIds.length > 1) {
      throw new Error(`Multiple persisted test IDs found for logical cluster ${cluster.key}.`);
    }
    const proposedKey = existingIds[0] || cluster.key;
    const testId = existingIds[0] || proposedIds.get(proposedKey) || createTestId();
    proposedIds.set(proposedKey, testId);
    const result = canonicalClusterResult(cluster.runs, clusterEvents);
    const shares = chooseShareSet(cluster.runs);
    const shareAnalysis = analyzeShares({
      shares: shares.watchTimeShare,
      options: shares.options
    });
    const sharePresent = Object.values(shares.watchTimeShare || {}).some(Number.isFinite);
    const latestAction = latestActiveAction(clusterActions);
    const appliedVariant = latestAppliedVariant(clusterEvents);
    const terminalEvidence = hasTerminalEvidence({
      runs: cluster.runs,
      events: clusterEvents
    });
    const lifecycleStatus = terminalEvidence ? "finished" : "unknown";
    const dataQualityFlag = terminalEvidence
      ? ""
      : dateOnly(representative.startDate)
        ? "missing_finish_evidence"
        : "missing_start_and_finish_evidence";
    const contentHash = testContentHash(representative);
    const logical = {
      testId,
      primaryTestRunId: representative.testRunId,
      videoId: representative.videoId || "",
      testType: representative.testType || "",
      sourceKind: representative.sourceKind || "",
      lifecycleStatus,
      dataQualityFlag,
      result: result.result,
      resultEvidence: result.resultEvidence,
      resultSemanticsVersion: RESULT_SEMANTICS_VERSION,
      explicitWinnerVariant: result.explicitWinnerVariant || "",
      highestShareVariant: shareAnalysis.highestShareVariant || "",
      operationalDecision: latestAction?.action || "",
      youtubeAppliedVariant: appliedVariant,
      inconclusiveReason: result.inconclusiveReason || "",
      inconclusiveReasonEvidence: result.inconclusiveReasonEvidence || "",
      contentHash,
      configuredVariantCount: shareAnalysis.configuredVariantCount,
      populatedShareCount: shareAnalysis.populatedShareCount,
      shareSum: shareAnalysis.shareSum,
      shareSumValid: shareAnalysis.shareSumValid,
      shareQuality: shareAnalysis.quality,
      sharePresent,
      startDate: representative.startDate || "",
      terminalEvidence,
      sourceRecordCount: cluster.runs.length,
      sourceRunIds: cluster.runs.map((run) => run.testRunId),
      appManaged: representative.sourceKind === "app_registry"
    };
    logicalTests.push(logical);

    for (const run of cluster.runs) {
      const update = {
        testRunId: run.testRunId,
        testId,
        contentHash: testContentHash(run),
        result: result.result,
        resultEvidence: result.resultEvidence,
        resultSemanticsVersion: RESULT_SEMANTICS_VERSION,
        explicitWinnerVariant: result.explicitWinnerVariant || "",
        highestShareVariant: shareAnalysis.highestShareVariant || "",
        operationalDecision: latestAction?.action || "",
        youtubeAppliedVariant: appliedVariant,
        inconclusiveReason: result.inconclusiveReason || "",
        inconclusiveReasonEvidence: result.inconclusiveReasonEvidence || ""
      };
      sourceUpdates.push(update);
      links.push({
        testRunId: run.testRunId,
        testId,
        linkageMethod: run.testId ? "existing_test_id" : "historical_cluster",
        linkageConfidence: "deterministic"
      });
      for (const aliasValue of identityAliases({ ...run, contentHash: update.contentHash })) {
        aliases.push({
          aliasId: `alias_${sha1(aliasValue)}`,
          testId,
          aliasType: aliasValue.split(":", 1)[0],
          aliasValue
        });
      }
      idHistory.push({
        historyId: `idh_${sha1(`${migrationId}|${testId}|${run.testRunId}`)}`,
        testId,
        testRunId: run.testRunId,
        eventType: run.testId ? "identity_preserved" : "identity_assigned",
        oldValue: { testId: run.testId || "" },
        newValue: { testId, contentHash: update.contentHash },
        reason: "Historical result-semantics migration",
        migrationId
      });
      audit.push(
        ...buildAuditEntries({
          migrationId,
          testId,
          testRunId: run.testRunId,
          oldRecord: legacyResultShape(run),
          newRecord: update,
          evidence: result.resultEvidence,
          reason: result.reason
        })
      );
    }

    for (const event of clusterEvents) {
      const eventResult =
        event.source === "metadata"
          ? classifyStudioResult("")
          : classifyStudioResult(event.rawText);
      eventUpdates.push({
        eventId: event.eventId,
        testId,
        result: eventResult.result,
        resultEvidence: eventResult.resultEvidence,
        resultSemanticsVersion: RESULT_SEMANTICS_VERSION,
        explicitWinnerVariant: eventResult.explicitWinnerVariant || "",
        youtubeAppliedVariant: appliedVariantFromEvent(event),
        inconclusiveReason: eventResult.inconclusiveReason || "",
        inconclusiveReasonEvidence: eventResult.inconclusiveReasonEvidence || ""
      });
    }
    for (const action of clusterActions) {
      actionUpdates.push({
        actionId: action.actionId,
        testId
      });
    }
  }

  const snapshot = migrationSnapshot({ runs, events, actions });
  const preMigrationChecksum = checksum(snapshot);
  const summary = summarizeMigrationPlan({
    logicalTests,
    asOfUtc,
    sourceRecordCount: runs.length,
    sheetSourceRecordCount: sourceRuns.length,
    appSourceRecordCount: appRuns.length,
    legacyShareWinnerCount: sheetClusters.filter((cluster) =>
      cluster.runs.some(
        (run) =>
          /^winner_[abc]$/i.test(String(run.detectedOutcome || "")) &&
          /highest watch-time share/i.test(String(run.winnerReason || ""))
      )
    ).length
  });
  const planCore = {
    migrationId,
    semanticsVersion: RESULT_SEMANTICS_VERSION,
    preMigrationChecksum,
    summary,
    logicalTests,
    sourceUpdates,
    eventUpdates: uniqueBy(eventUpdates, (item) => item.eventId),
    actionUpdates: uniqueBy(actionUpdates, (item) => item.actionId),
    aliases: uniqueBy(aliases, (item) => item.aliasValue),
    links: uniqueBy(links, (item) => item.testRunId),
    idHistory: uniqueBy(idHistory, (item) => item.historyId),
    audit
  };
  return {
    ...planCore,
    planChecksum: checksum(planCore),
    snapshot
  };
}

export function summarizeMigrationPlan({
  logicalTests,
  asOfUtc = new Date().toISOString(),
  sourceRecordCount = 0,
  sheetSourceRecordCount = 0,
  appSourceRecordCount = 0,
  legacyShareWinnerCount = 0
}) {
  const sheetTests = logicalTests.filter((test) => !test.appManaged);
  const terminal = sheetTests.filter((test) => test.lifecycleStatus === "finished");
  const resultDistribution = countBy(
    sheetTests,
    (test) => `${test.result}|${test.resultEvidence}`
  );
  const sharesPresent = terminal.filter((test) => test.sharePresent).length;
  const strictShares = terminal.filter((test) => test.shareSumValid).length;
  const resultEvidence = terminal.filter((test) =>
    ["studio_explicit", "sheet_explicit"].includes(test.resultEvidence)
  ).length;
  const missingStartAndFinish = sheetTests.filter(
    (test) => test.dataQualityFlag === "missing_start_and_finish_evidence"
  ).length;
  const missingFinish = sheetTests.filter(
    (test) => test.dataQualityFlag === "missing_finish_evidence"
  ).length;
  const nonTerminal = sheetTests.filter((test) => !test.terminalEvidence);
  const nonTerminalOverThreeWeeks = nonTerminal.filter(
    (test) => test.startDate && ageInDays(test.startDate, asOfUtc) > 21
  ).length;
  const reviewerDecisionOnly = nonTerminal.filter((test) => test.operationalDecision).length;
  const legacyWinnerRows = sheetTests.filter(
    (test) => test.result === "winner" && test.resultEvidence === "inferred_legacy"
  ).length;
  const resultCount = (value) => sheetTests.filter((test) => test.result === value).length;
  return {
    sourceRecordCount,
    sheetSourceRecordCount,
    appSourceRecordCount,
    logicalTestCount: sheetTests.length,
    appManagedLogicalTestCount: logicalTests.length - sheetTests.length,
    terminalTestCount: terminal.length,
    resultEvidenceCount: resultEvidence,
    sharesPresentCount: sharesPresent,
    strictSharesCount: strictShares,
    missingStartAndFinishCount: missingStartAndFinish,
    missingFinishCount: missingFinish,
    nonTerminalTestCount: nonTerminal.length,
    nonTerminalWithUsableStartCount: nonTerminal.filter((test) => test.startDate).length,
    nonTerminalOverThreeWeeksCount: nonTerminalOverThreeWeeks,
    coverageDenominators: coverageDenominators({
      strictTerminalCount: terminal.length,
      widerCount: terminal.length + nonTerminalOverThreeWeeks,
      resultEvidence,
      sharesPresent,
      strictShares
    }),
    asOfUtc,
    reviewerDecisionOnlyCount: reviewerDecisionOnly,
    legacyWinnerRows,
    resultDistribution,
    dashboardVisibleChanges: {
      legacyShareInferredWinnerLabels: {
        before: legacyShareWinnerCount,
        after: 0
      },
      youtubeWinnerResults: {
        before: null,
        after: resultCount("winner")
      },
      performedSameResults: {
        before: null,
        after: resultCount("performed_same")
      },
      inconclusiveResults: {
        before: null,
        after: resultCount("inconclusive")
      },
      unknownResults: {
        before: null,
        after: resultCount("unknown")
      },
      highestShareDescriptiveValues: {
        before: 0,
        after: sheetTests.filter((test) => test.highestShareVariant).length
      }
    }
  };
}

export function migrationSnapshot({ runs = [], events = [], actions = [] } = {}) {
  return {
    runs: runs
      .map((run) => ({
        testRunId: run.testRunId,
        testId: run.testId || "",
        contentHash: run.contentHash || "",
        result: run.result || "",
        resultEvidence: run.resultEvidence || "",
        resultSemanticsVersion: run.resultSemanticsVersion || "",
        explicitWinnerVariant: run.explicitWinnerVariant || "",
        highestShareVariant: run.highestShareVariant || "",
        operationalDecision: run.operationalDecision || "",
        youtubeAppliedVariant: run.youtubeAppliedVariant || "",
        inconclusiveReason: run.inconclusiveReason || "",
        inconclusiveReasonEvidence: run.inconclusiveReasonEvidence || ""
      }))
      .sort(byId("testRunId")),
    events: events
      .map((event) => ({
        eventId: event.eventId,
        testId: event.testId || "",
        result: event.result || "",
        resultEvidence: event.resultEvidence || "",
        resultSemanticsVersion: event.resultSemanticsVersion || "",
        explicitWinnerVariant: event.explicitWinnerVariant || "",
        youtubeAppliedVariant: event.youtubeAppliedVariant || "",
        inconclusiveReason: event.inconclusiveReason || "",
        inconclusiveReasonEvidence: event.inconclusiveReasonEvidence || ""
      }))
      .sort(byId("eventId")),
    actions: actions
      .map((action) => ({
        actionId: action.actionId,
        testId: action.testId || ""
      }))
      .sort(byId("actionId"))
  };
}

export function checksum(value) {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function verifyRollbackSnapshot(before, restored) {
  return {
    beforeChecksum: checksum(before),
    restoredChecksum: checksum(restored),
    exact: checksum(before) === checksum(restored)
  };
}

function clusterRuns(runs) {
  const clusters = new Map();
  for (const run of runs) {
    const key = historicalLogicalKey(run);
    const cluster = clusters.get(key) || { key, runs: [] };
    cluster.runs.push(run);
    clusters.set(key, cluster);
  }
  return Array.from(clusters.values());
}

function clusterAppRuns(runs) {
  const clusters = new Map();
  for (const run of runs) {
    const videoId = String(run.videoId || "").trim();
    const title = normalizeText(run.currentYoutubeTitle || run.videoTitle);
    const channel = normalizeText(run.youtubeChannelId || run.youtubeChannelTitle || run.channel);
    const key = videoId
      ? `app|${videoId}|${run.testType || ""}`
      : `app-title|${title}|${run.testType || ""}|${channel}|${run.testRunId}`;
    const cluster = clusters.get(key) || { key, runs: [] };
    cluster.runs.push(run);
    clusters.set(key, cluster);
  }
  return Array.from(clusters.values());
}

function historicalLogicalKey(run) {
  const videoId = String(run.videoId || "").trim();
  const testType = String(run.testType || "").trim();
  const startDate = dateOnly(run.startDate);
  const fingerprint = String(run.optionFingerprint || "").trim();
  if (!videoId || !testType || (!startDate && !fingerprint)) {
    return `source|${run.testRunId}`;
  }
  return [videoId, testType, startDate, fingerprint].join("|");
}

function canonicalClusterResult(runs, events) {
  const studioResults = events
    .filter((event) => event.source !== "metadata")
    .map((event) => ({
      ...classifyStudioResult(event.rawText),
      event
    }))
    .filter((result) => result.result !== "unknown")
    .sort((left, right) => {
      const time = new Date(right.event.occurredAt || right.event.observedAt || 0) -
        new Date(left.event.occurredAt || left.event.observedAt || 0);
      if (time) return time;
      return resultPriority(right) - resultPriority(left);
    });
  if (studioResults[0]) {
    return {
      ...studioResults[0],
      reason: `Explicit Studio notification ${studioResults[0].event.eventId}`
    };
  }

  const sheetResults = runs
    .map((run) => classifySheetResult({ shares: run.watchTimeShare }))
    .filter((result) => result.result !== "unknown");
  if (sheetResults[0]) {
    return {
      ...sheetResults[0],
      reason: "Explicit result text in configured sheet"
    };
  }

  return {
    result: "unknown",
    resultEvidence: "unknown",
    resultSemanticsVersion: RESULT_SEMANTICS_VERSION,
    explicitWinnerVariant: "",
    inconclusiveReason: "",
    inconclusiveReasonEvidence: "",
    reason: "No explicit YouTube or sheet result evidence"
  };
}

function associateEvents({ clusters, events, clusterByRunId }) {
  const map = new Map(clusters.map((cluster) => [cluster.key, []]));
  const clustersByVideo = new Map();
  for (const cluster of clusters) {
    const videoIds = Array.from(new Set(cluster.runs.map((run) => run.videoId).filter(Boolean)));
    for (const videoId of videoIds) {
      const values = clustersByVideo.get(videoId) || [];
      values.push(cluster);
      clustersByVideo.set(videoId, values);
    }
  }
  for (const event of events) {
    if (!["matched", "superseded"].includes(event.processingStatus || "")) continue;
    const direct = clusterByRunId.get(event.testRunId);
    if (direct) {
      map.get(direct.key).push(event);
      continue;
    }
    const candidates = clustersByVideo.get(event.videoId) || [];
    if (candidates.length === 1) map.get(candidates[0].key).push(event);
  }
  return map;
}

function associateActions({ actions, clusterByRunId }) {
  const map = new Map();
  for (const action of actions) {
    const cluster = clusterByRunId.get(action.testRunId);
    if (!cluster) continue;
    const values = map.get(cluster.key) || [];
    values.push(action);
    map.set(cluster.key, values);
  }
  return map;
}

function hasTerminalEvidence({ runs, events }) {
  if (events.some((event) => classifyStudioResult(event.rawText).result !== "unknown")) return true;
  if (
    events.some(
      (event) =>
        event.source !== "metadata" &&
        /^test finished\.\s*ran from .{8,180}? to .{8,180}?\.$/i.test(
          String(event.rawText || "").replace(/\s+/g, " ").trim()
        )
    )
  ) {
    return true;
  }
  if (
    events.some(
      (event) =>
        event.source === "metadata" &&
        Boolean(appliedVariantFromEvent(event))
    )
  ) {
    return true;
  }
  return runs.some((run) => {
    if (dateOnly(run.finishDate)) return true;
    if (["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(run.status)) return true;
    if (classifySheetResult({ shares: run.watchTimeShare }).result !== "unknown") return true;
    return Object.values(run.watchTimeShare || {}).some(Number.isFinite);
  });
}

function chooseShareSet(runs) {
  return [...runs]
    .map((run) => ({
      options: run.options || {},
      watchTimeShare: run.watchTimeShare || {},
      score:
        Object.values(run.watchTimeShare || {}).filter(Number.isFinite).length * 100 +
        Object.values(run.options || {}).filter(Boolean).length
    }))
    .sort((left, right) => right.score - left.score)[0] || { options: {}, watchTimeShare: {} };
}

function chooseRepresentative(runs) {
  return [...runs].sort((left, right) => {
    const score = representativeScore(right) - representativeScore(left);
    if (score) return score;
    return new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
  })[0];
}

function representativeScore(run) {
  return (
    (run.videoId ? 100 : 0) +
    (dateOnly(run.startDate) ? 50 : 0) +
    (dateOnly(run.finishDate) ? 40 : 0) +
    Object.values(run.options || {}).filter(Boolean).length * 10 +
    Object.values(run.watchTimeShare || {}).filter(Number.isFinite).length * 10
  );
}

function latestActiveAction(actions) {
  return [...actions]
    .filter((action) => !action.undoneAt)
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))[0] || null;
}

function latestAppliedVariant(events) {
  return [...events]
    .sort((left, right) => new Date(right.observedAt || 0) - new Date(left.observedAt || 0))
    .map(appliedVariantFromEvent)
    .find(Boolean) || "";
}

function appliedVariantFromEvent(event) {
  const explicit = String(event.youtubeAppliedVariant || "").toUpperCase();
  if (["A", "B", "C"].includes(explicit)) return explicit;
  const match = String(event.detectedOutcome || "").match(/^applied_([abc])$/i);
  if (match) return match[1].toUpperCase();
  const legacyMetadataMatch =
    event.source === "metadata"
      ? String(event.detectedOutcome || "").match(/^winner_([abc])$/i)
      : null;
  return legacyMetadataMatch ? legacyMetadataMatch[1].toUpperCase() : "";
}

function legacyResultShape(run) {
  return {
    testId: run.testId || "",
    contentHash: run.contentHash || "",
    result: run.result || legacyOutcomeResult(run.detectedOutcome),
    resultEvidence: run.resultEvidence || legacyOutcomeEvidence(run),
    resultSemanticsVersion: run.resultSemanticsVersion || "",
    explicitWinnerVariant: run.explicitWinnerVariant || legacyWinnerVariant(run),
    highestShareVariant: run.highestShareVariant || "",
    operationalDecision: run.operationalDecision || "",
    youtubeAppliedVariant: run.youtubeAppliedVariant || "",
    inconclusiveReason: run.inconclusiveReason || "",
    inconclusiveReasonEvidence: run.inconclusiveReasonEvidence || ""
  };
}

function legacyOutcomeResult(outcome) {
  if (/^winner_[abc]$/i.test(String(outcome || ""))) return "winner";
  if (String(outcome || "") === "no_clear") return "inconclusive";
  return "unknown";
}

function legacyOutcomeEvidence(run) {
  if (/highest watch-time share/i.test(String(run.winnerReason || ""))) return "inferred_legacy";
  if (/^winner_[abc]$/i.test(String(run.detectedOutcome || ""))) return "inferred_legacy";
  if (String(run.detectedOutcome || "") === "no_clear") return "sheet_explicit";
  return "unknown";
}

function legacyWinnerVariant(run) {
  return String(run.detectedOutcome || "").match(/^winner_([abc])$/i)?.[1]?.toUpperCase() || "";
}

function buildAuditEntries({
  migrationId,
  testId,
  testRunId,
  oldRecord,
  newRecord,
  evidence,
  reason
}) {
  return Object.keys(newRecord)
    .filter((field) => !["testRunId"].includes(field))
    .filter((field) => stableStringify(oldRecord[field]) !== stableStringify(newRecord[field]))
    .map((field) => ({
      auditId: `audit_${sha1(`${migrationId}|${testRunId}|${field}`)}`,
      migrationId,
      testId,
      testRunId,
      fieldName: field,
      oldValue: oldRecord[field] ?? null,
      newValue: newRecord[field] ?? null,
      evidence,
      reason,
      semanticsVersion: RESULT_SEMANTICS_VERSION
    }));
}

function countBy(items, keyFn) {
  return Object.fromEntries(
    Array.from(items.reduce((map, item) => {
      const key = keyFn(item);
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map()).entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}

function resultPriority(result) {
  return (EVIDENCE_PRIORITY[result.resultEvidence] || 0) + (result.result === "winner" ? 3 : 0);
}

function uniqueBy(items, keyFn) {
  const map = new Map();
  for (const item of items) if (!map.has(keyFn(item))) map.set(keyFn(item), item);
  return Array.from(map.values());
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10);
}

function ageInDays(startDate, asOfUtc) {
  const start = new Date(`${dateOnly(startDate)}T00:00:00.000Z`);
  const asOf = new Date(asOfUtc);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(asOf.valueOf())) return 0;
  return Math.floor((asOf.valueOf() - start.valueOf()) / 86_400_000);
}

function coverageDenominators({
  strictTerminalCount,
  widerCount,
  resultEvidence,
  sharesPresent,
  strictShares
}) {
  return {
    strictTerminalEvidence: coverageSet({
      denominator: strictTerminalCount,
      resultEvidence,
      sharesPresent,
      strictShares
    }),
    terminalPlusOverThreeWeeks: coverageSet({
      denominator: widerCount,
      resultEvidence,
      sharesPresent,
      strictShares
    })
  };
}

function coverageSet({ denominator, resultEvidence, sharesPresent, strictShares }) {
  const rate = (count) => denominator ? Number((count / denominator).toFixed(6)) : null;
  return {
    denominator,
    resultEvidence: { count: resultEvidence, rate: rate(resultEvidence) },
    sharesPresent: { count: sharesPresent, rate: rate(sharesPresent) },
    strictShares: { count: strictShares, rate: rate(strictShares) }
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function byId(field) {
  return (left, right) => String(left[field] || "").localeCompare(String(right[field] || ""));
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value), "utf8").digest("hex");
}
