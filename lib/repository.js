import crypto from "node:crypto";
import { ensureSchema, fromJson, getSql, toJson } from "@/lib/db.js";
import {
  detectAppliedChange,
  consolidateUnmatchedFinishEvents,
  finishEventHash,
  alignFinishEventToMatchedRun,
  eventTitleMatchesRun,
  isLikelyFinishNotification,
  isPromotableStudioFinishEvent,
  matchFinishEventToRun,
  notificationTitleMatchesVideoMetadata,
  normalizeMatchText,
  parseStudioNotification,
  resolveEventOccurredAt
} from "@/lib/finish-events.mjs";
import { canonicalChannelName } from "@/lib/channels.mjs";
import { deriveQueueStatus } from "@/lib/queue-status.mjs";
import { dedupeQueueRuns } from "@/lib/queue-dedupe.mjs";
import { fetchYouTubeVideoMetadata, findYouTubeVideoCandidates } from "@/lib/youtube.js";
import { previewDisplayUrl } from "@/lib/blob.js";
import { appManagedRunIdentity } from "@/lib/app-registry.mjs";
import { planAppManagedConsolidation } from "@/lib/app-registry-consolidation.mjs";
import {
  dedupeIdentityAliasesForPersistence,
  identityAliases,
  resolvePersistedTestId,
  testContentHash
} from "@/lib/test-identity.mjs";
import { projectCanonicalResult } from "@/lib/result-semantics.mjs";
import { ScanCancelledError } from "@/lib/scan-cancellation.mjs";
import { planLegacyYearlessDateReconciliation } from "@/lib/legacy-date-reconciliation.mjs";
import { formatDateOnly } from "@/lib/date-only.mjs";
import { planExactMaterialReconciliation } from "@/lib/exact-material-reconciliation.mjs";

export async function createScanRun({ actorName, requestedScanId = "" }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE scan_runs
    SET status = 'cancelled',
        completed_at = COALESCE(completed_at, NOW()),
        summary = jsonb_build_object('cancelled', true, 'message', 'Requested stop recovered before a restart.'),
        progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'cancelled',
          'label', 'Scan stopped',
          'detail', 'The previous stop request was finalized before starting this scan.',
          'updatedAt', NOW()
        )
    WHERE status = 'running'
      AND COALESCE(progress->>'stage', '') = 'cancel_requested'
      AND CASE
        WHEN COALESCE(progress->>'updatedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          THEN (progress->>'updatedAt')::timestamptz
        ELSE started_at
      END < NOW() - INTERVAL '30 seconds'
  `;
  await sql`
    UPDATE scan_runs
    SET status = 'failed',
        completed_at = COALESCE(completed_at, NOW()),
        summary = jsonb_build_object('error', 'Scan stopped reporting progress and was replaced.'),
        progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'failed',
          'label', 'Scan interrupted',
          'detail', 'A new scan replaced this stale run.',
          'percent', CASE
            WHEN COALESCE(progress->>'percent', '') ~ '^[0-9]+$' THEN (progress->>'percent')::int
            ELSE 0
          END,
          'updatedAt', NOW()
        )
    WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '12 minutes'
      AND CASE
        WHEN COALESCE(progress->>'updatedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          THEN (progress->>'updatedAt')::timestamptz
        ELSE started_at
      END < NOW() - INTERVAL '5 minutes'
  `;
  const scanId = /^[A-Za-z0-9_-]{8,80}$/.test(String(requestedScanId || ""))
    ? String(requestedScanId)
    : crypto.randomUUID();
  try {
    await sql`
      INSERT INTO scan_runs (scan_id, started_at, status, actor_name, progress)
      VALUES (${scanId}, NOW(), 'running', ${actorName || "system"}, ${toJson({
        stage: "starting",
        label: "Starting scan",
        detail: "Preparing sheet and YouTube checks.",
        percent: 2,
        steps: scanProgressSteps("starting"),
        updatedAt: new Date().toISOString()
      })}::jsonb)
    `;
  } catch (error) {
    if (String(error?.code || "") === "23505" || /scan_runs_single_running_idx/i.test(error?.message || "")) {
      const active = await lastScanRun();
      const conflict = new Error(`A scan started by ${active?.actorName || "another reviewer"} is already running.`);
      conflict.status = 409;
      conflict.activeScan = active;
      throw conflict;
    }
    throw error;
  }
  return scanId;
}

export async function completeScanRun({ scanId, status, summary, warnings, counts = {}, timings = {} }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE scan_runs
    SET completed_at = NOW(),
        status = ${status},
        summary = ${toJson(summary)}::jsonb,
        progress = ${toJson({
          stage: status === "ok" ? "complete" : "failed",
          label: status === "ok" ? "Scan complete" : "Scan failed",
          detail: status === "ok" ? "Queue and counts are updated." : summary?.error || "Scan failed.",
          percent: 100,
          counts: {
            ...counts,
            timings
          },
          steps: scanProgressSteps(status === "ok" ? "complete" : "failed"),
          updatedAt: new Date().toISOString()
        })}::jsonb,
        warnings = ${toJson(warnings || [])}::jsonb
    WHERE scan_id = ${scanId}
      AND (
        ${status !== "ok"}
        OR (
          status = 'running'
          AND COALESCE(progress->>'stage', '') <> 'cancel_requested'
        )
      )
    RETURNING scan_id
  `;
  if (status === "ok" && !rows[0]) await assertScanActive(scanId);
}

export async function requestScanCancellation({ scanId, actorName = "Reviewer" }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE scan_runs
    SET progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'cancel_requested',
          'label', 'Stopping safely',
          'detail', 'Finishing the current safe step, then stopping without publishing an incomplete scan.',
          'cancelRequestedBy', ${actorName || "Reviewer"}::text,
          'cancelRequestedAt', NOW(),
          'updatedAt', NOW()
        )
    WHERE scan_id = ${scanId}
      AND status = 'running'
    RETURNING scan_id, started_at, completed_at, status, summary, progress, warnings, actor_name
  `;
  if (rows[0]) return { requested: true, scan: scanRow(rows[0]) };
  const existing = await sql`
    SELECT scan_id, started_at, completed_at, status, summary, progress, warnings, actor_name
    FROM scan_runs
    WHERE scan_id = ${scanId}
    LIMIT 1
  `;
  if (!existing[0]) {
    const error = new Error("The active scan no longer exists. Refresh and try again.");
    error.status = 404;
    throw error;
  }
  return { requested: false, alreadyFinished: existing[0].status !== "running", scan: scanRow(existing[0]) };
}

export async function assertScanActive(scanId) {
  await ensureSchema();
  const sql = getSql();
  const state = await loadScanState(sql, scanId);
  if (!state || state.status !== "running" || state.stage === "cancel_requested") {
    throw new ScanCancelledError();
  }
  return true;
}

export async function completeCancelledScanRun({ scanId, warnings = [], counts = {}, timings = {}, actorName = "Reviewer" }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE scan_runs
    SET completed_at = NOW(),
        status = 'cancelled',
        summary = jsonb_build_object(
          'cancelled', true,
          'message', 'Scan stopped by reviewer. The existing queue remains available.'
        ),
        progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
          'stage', 'cancelled',
          'label', 'Scan stopped',
          'detail', 'Stopped safely. The existing queue remains available and a new scan can start now.',
          'counts', ${toJson({ ...counts, timings })}::jsonb,
          'cancelledBy', ${actorName || "Reviewer"}::text,
          'updatedAt', NOW()
        ),
        warnings = ${toJson(warnings || [])}::jsonb
    WHERE scan_id = ${scanId}
      AND status = 'running'
    RETURNING scan_id, started_at, completed_at, status, summary, progress, warnings, actor_name
  `;
  return rows[0] ? scanRow(rows[0]) : null;
}

export async function updateScanProgress({ scanId, stage, label, detail = "", percent = 0, counts = {}, deferCancellation = false }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE scan_runs
    SET progress = ${toJson({
      stage,
      label,
      detail,
      percent: Math.max(0, Math.min(99, Number(percent) || 0)),
      counts,
      steps: scanProgressSteps(stage),
      updatedAt: new Date().toISOString()
    })}::jsonb
    WHERE scan_id = ${scanId}
      AND status = 'running'
      AND COALESCE(progress->>'stage', '') <> 'cancel_requested'
    RETURNING scan_id
  `;
  if (!rows[0]) {
    const state = await loadScanState(sql, scanId);
    if (deferCancellation && state?.status === "running" && state.stage === "cancel_requested") return false;
    await assertScanActive(scanId);
  }
  return true;
}

async function loadScanState(sql, scanId) {
  const rows = await sql`
    SELECT status, COALESCE(progress->>'stage', '') AS stage
    FROM scan_runs
    WHERE scan_id = ${scanId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function lastScanRun() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT scan_id, started_at, completed_at, status, summary, progress, warnings, actor_name
    FROM scan_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ? scanRow(rows[0]) : null;
}

export async function lastSuccessfulScanRun() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT scan_id, started_at, completed_at, status, summary, progress, warnings, actor_name
    FROM scan_runs
    WHERE status = 'ok' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `;
  return rows[0] ? scanRow(rows[0]) : null;
}

export async function recordDiagnosticLog({ category, severity = "info", message = "", actorName = "", context = {} }) {
  try {
    await ensureSchema();
    const sql = getSql();
    const logId = `diag_${crypto.randomUUID()}`;
    await sql`
      INSERT INTO diagnostic_logs (
        log_id,
        category,
        severity,
        message,
        actor_name,
        context
      )
      VALUES (
        ${logId},
        ${String(category || "app").slice(0, 80)},
        ${String(severity || "info").slice(0, 24)},
        ${String(message || "").slice(0, 500)},
        ${String(actorName || "").slice(0, 120)},
        ${toJson(redactDiagnosticContext(context))}::jsonb
      )
    `;
    return logId;
  } catch {
    return "";
  }
}

export async function listDiagnosticLogs({ limit = 100, category = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
  const rows = category
    ? await sql`
        SELECT log_id, category, severity, message, actor_name, context, created_at
        FROM diagnostic_logs
        WHERE category = ${category}
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `
    : await sql`
        SELECT log_id, category, severity, message, actor_name, context, created_at
        FROM diagnostic_logs
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `;
  return rows.map((row) => ({
    logId: row.log_id,
    category: row.category,
    severity: row.severity,
    message: row.message,
    actorName: row.actor_name,
    context: fromJson(row.context, {}),
    createdAt: row.created_at
  }));
}

function redactDiagnosticContext(value) {
  if (Array.isArray(value)) return value.slice(0, 50).map(redactDiagnosticContext);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/token|password|secret|key|authorization|credential/i.test(key)) {
        return [key, item ? "[redacted]" : ""];
      }
      return [key, redactDiagnosticContext(item)];
    })
  );
}

export async function upsertScannedRuns({ records, scanId, onProgress }) {
  await ensureSchema();
  const sql = getSql();
  await reuseExistingRunIds(sql, records);
  await assignPersistentTestIds(sql, records);
  const existingById = await loadExistingRunState(
    sql,
    records.map((record) => record.testRunId)
  );
  const touchedVideoIds = new Set(records.map((record) => record.videoId).filter(Boolean));
  const writeBatchSize = 150;
  let writeBatch = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const current = existingById.get(record.testRunId);
    if (current?.video_id) touchedVideoIds.add(current.video_id);
    const hasAction = Boolean(current?.has_action);
    const changedAfterDone =
      hasAction &&
      current?.source_payload_hash &&
      current.source_payload_hash !== record.sourcePayloadHash;
    const driftedAt = changedAfterDone ? new Date().toISOString() : null;
    const driftReason = changedAfterDone ? "source_changed_after_done" : "";
    const previousHash = changedAfterDone ? current.source_payload_hash : "";

    writeBatch.push(scannedRunDbRow({ record, scanId, driftedAt, driftReason, previousHash }));
    if (writeBatch.length >= writeBatchSize || index + 1 === records.length) {
      await bulkUpsertScannedRuns(sql, writeBatch);
      await persistIdentityLinks(sql, writeBatch);
      writeBatch = [];
      if (onProgress) await onProgress({ saved: index + 1, total: records.length });
    }
  }

  const videoIds = Array.from(touchedVideoIds);
  if (videoIds.length) {
    await sql.query(
      `
        UPDATE test_runs current
        SET possible_retest = CASE
          WHEN current.source_kind NOT IN ('title', 'thumbnail') THEN FALSE
          WHEN current.start_date IS NULL AND current.option_fingerprint = '' THEN FALSE
          ELSE EXISTS (
            SELECT 1
            FROM test_runs other
            WHERE other.video_id = current.video_id
              AND other.video_id <> ''
              AND other.test_run_id <> current.test_run_id
              AND other.source_kind IN ('title', 'thumbnail')
              AND other.status <> 'source_removed'
              AND (other.start_date IS NOT NULL OR other.option_fingerprint <> '')
              AND (
                (
                  current.start_date IS NOT NULL
                  AND other.start_date IS NOT NULL
                  AND other.start_date <> current.start_date
                )
                OR (
                  current.option_fingerprint <> ''
                  AND other.option_fingerprint <> ''
                  AND other.option_fingerprint <> current.option_fingerprint
                )
              )
          )
        END
        WHERE current.video_id = ANY($1::text[])
      `,
      [videoIds]
    );
  }
}

function scannedRunDbRow({ record, scanId, driftedAt, driftReason, previousHash }) {
  return {
    test_run_id: record.testRunId,
    test_id: record.testId || "",
    identity_match: record.identityMatch || "",
    content_hash: record.contentHash || testContentHash(record),
    video_id: record.videoId || "",
    source_kind: record.sourceKind,
    spreadsheet_id: record.spreadsheetId,
    sheet_name: record.sheetName,
    row_number: Number(record.rowNumber || 0),
    test_type: record.testType,
    channel: record.channel || record.sheetName || "",
    video_title: record.videoTitle || "",
    video_url: record.videoUrl || "",
    studio_url: record.studioUrl || "",
    start_date: record.startDate || "",
    finish_date: record.finishDate || "",
    effective_finish_date: record.effectiveFinishDate || "",
    overdue_days: Number(record.overdueDays || 0),
    status: record.status,
    detected_outcome: record.detectedOutcome,
    suggested_winner: record.suggestedWinner || "",
    winner_reason: record.winnerReason || "",
    result: record.result || "unknown",
    result_evidence: record.resultEvidence || "unknown",
    result_semantics_version: record.resultSemanticsVersion || "",
    explicit_winner_variant: record.explicitWinnerVariant || "",
    highest_share_variant: record.highestShareVariant || "",
    operational_decision: record.operationalDecision || "",
    youtube_applied_variant: record.youtubeAppliedVariant || "",
    inconclusive_reason: record.inconclusiveReason || "",
    inconclusive_reason_evidence: record.inconclusiveReasonEvidence || "",
    options: record.options || {},
    watch_time_share: record.watchTimeShare || {},
    troubles: record.troubles || [],
    thumbnail_previews: record.thumbnailPreviews || {},
    current_youtube_title: record.currentYoutubeTitle || "",
    current_youtube_thumbnail_url: record.currentYoutubeThumbnailUrl || "",
    youtube_channel_id: record.youtubeChannelId || "",
    youtube_channel_title: record.youtubeChannelTitle || "",
    youtube_channel_thumbnail_url: record.youtubeChannelThumbnailUrl || "",
    option_fingerprint: record.optionFingerprint || "",
    row_fingerprint: record.rowFingerprint || "",
    source_payload_hash: record.sourcePayloadHash || "",
    source_payload: record.sourcePayload || {},
    last_seen_scan_id: scanId,
    drifted_at: driftedAt || "",
    drift_reason: driftReason,
    previous_source_payload_hash: previousHash
  };
}

async function bulkUpsertScannedRuns(sql, rows) {
  if (!rows.length) return;
  await sql.query(
    `
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row_data(
          test_run_id text,
          test_id text,
          content_hash text,
          video_id text,
          source_kind text,
          spreadsheet_id text,
          sheet_name text,
          row_number integer,
          test_type text,
          channel text,
          video_title text,
          video_url text,
          studio_url text,
          start_date text,
          finish_date text,
          effective_finish_date text,
          overdue_days integer,
          status text,
          detected_outcome text,
          suggested_winner text,
          winner_reason text,
          result text,
          result_evidence text,
          result_semantics_version text,
          explicit_winner_variant text,
          highest_share_variant text,
          operational_decision text,
          youtube_applied_variant text,
          inconclusive_reason text,
          inconclusive_reason_evidence text,
          options jsonb,
          watch_time_share jsonb,
          troubles jsonb,
          thumbnail_previews jsonb,
          current_youtube_title text,
          current_youtube_thumbnail_url text,
          youtube_channel_id text,
          youtube_channel_title text,
          youtube_channel_thumbnail_url text,
          option_fingerprint text,
          row_fingerprint text,
          source_payload_hash text,
          source_payload jsonb,
          last_seen_scan_id text,
          drifted_at text,
          drift_reason text,
          previous_source_payload_hash text
        )
      )
      INSERT INTO test_runs (
        test_run_id, test_id, content_hash, video_id, source_kind, spreadsheet_id, sheet_name, row_number,
        test_type, channel, video_title, video_url, studio_url, start_date, finish_date,
        effective_finish_date, overdue_days, status, detected_outcome, suggested_winner,
        winner_reason, result, result_evidence, result_semantics_version,
        explicit_winner_variant, highest_share_variant, operational_decision,
        youtube_applied_variant, inconclusive_reason, inconclusive_reason_evidence,
        options, watch_time_share, troubles, thumbnail_previews,
        current_youtube_title, current_youtube_thumbnail_url, youtube_channel_id,
        youtube_channel_title, youtube_channel_thumbnail_url, option_fingerprint,
        row_fingerprint, source_payload_hash, source_payload, updated_at, last_seen_scan_id,
        drifted_at, drift_reason, previous_source_payload_hash
      )
      SELECT
        test_run_id, NULLIF(test_id, ''), content_hash, video_id, source_kind, spreadsheet_id, sheet_name, row_number,
        test_type, channel, video_title, video_url, studio_url, NULLIF(start_date, '')::date,
        NULLIF(finish_date, '')::date, NULLIF(effective_finish_date, '')::date,
        overdue_days, status, detected_outcome, suggested_winner, winner_reason,
        result, result_evidence, result_semantics_version, explicit_winner_variant,
        highest_share_variant, operational_decision, youtube_applied_variant,
        inconclusive_reason, inconclusive_reason_evidence,
        COALESCE(options, '{}'::jsonb), COALESCE(watch_time_share, '{}'::jsonb),
        COALESCE(troubles, '[]'::jsonb), COALESCE(thumbnail_previews, '{}'::jsonb),
        current_youtube_title, current_youtube_thumbnail_url, youtube_channel_id,
        youtube_channel_title, youtube_channel_thumbnail_url, option_fingerprint,
        row_fingerprint, source_payload_hash, COALESCE(source_payload, '{}'::jsonb),
        NOW(), last_seen_scan_id, NULLIF(drifted_at, '')::timestamptz, drift_reason,
        previous_source_payload_hash
      FROM incoming
      ON CONFLICT (test_run_id)
      DO UPDATE SET
        test_id = COALESCE(test_runs.test_id, EXCLUDED.test_id),
        content_hash = EXCLUDED.content_hash,
        video_id = EXCLUDED.video_id,
        source_kind = EXCLUDED.source_kind,
        spreadsheet_id = EXCLUDED.spreadsheet_id,
        sheet_name = EXCLUDED.sheet_name,
        row_number = EXCLUDED.row_number,
        test_type = EXCLUDED.test_type,
        channel = EXCLUDED.channel,
        video_title = EXCLUDED.video_title,
        video_url = EXCLUDED.video_url,
        studio_url = EXCLUDED.studio_url,
        start_date = EXCLUDED.start_date,
        finish_date = EXCLUDED.finish_date,
        effective_finish_date = EXCLUDED.effective_finish_date,
        overdue_days = EXCLUDED.overdue_days,
        status = EXCLUDED.status,
        detected_outcome = EXCLUDED.detected_outcome,
        suggested_winner = EXCLUDED.suggested_winner,
        winner_reason = EXCLUDED.winner_reason,
        result = EXCLUDED.result,
        result_evidence = EXCLUDED.result_evidence,
        result_semantics_version = EXCLUDED.result_semantics_version,
        explicit_winner_variant = EXCLUDED.explicit_winner_variant,
        highest_share_variant = EXCLUDED.highest_share_variant,
        operational_decision = CASE
          WHEN test_runs.operational_decision <> '' THEN test_runs.operational_decision
          ELSE EXCLUDED.operational_decision
        END,
        youtube_applied_variant = CASE
          WHEN EXCLUDED.youtube_applied_variant <> '' THEN EXCLUDED.youtube_applied_variant
          ELSE test_runs.youtube_applied_variant
        END,
        inconclusive_reason = EXCLUDED.inconclusive_reason,
        inconclusive_reason_evidence = EXCLUDED.inconclusive_reason_evidence,
        options = EXCLUDED.options,
        watch_time_share = EXCLUDED.watch_time_share,
        troubles = EXCLUDED.troubles,
        thumbnail_previews = EXCLUDED.thumbnail_previews,
        current_youtube_title = EXCLUDED.current_youtube_title,
        current_youtube_thumbnail_url = EXCLUDED.current_youtube_thumbnail_url,
        youtube_channel_id = EXCLUDED.youtube_channel_id,
        youtube_channel_title = EXCLUDED.youtube_channel_title,
        youtube_channel_thumbnail_url = EXCLUDED.youtube_channel_thumbnail_url,
        option_fingerprint = EXCLUDED.option_fingerprint,
        row_fingerprint = EXCLUDED.row_fingerprint,
        source_payload_hash = EXCLUDED.source_payload_hash,
        source_payload = EXCLUDED.source_payload,
        updated_at = NOW(),
        last_seen_scan_id = EXCLUDED.last_seen_scan_id,
        drifted_at = COALESCE(test_runs.drifted_at, EXCLUDED.drifted_at),
        drift_reason = CASE
          WHEN test_runs.drifted_at IS NULL AND EXCLUDED.drift_reason <> '' THEN EXCLUDED.drift_reason
          ELSE test_runs.drift_reason
        END,
        previous_source_payload_hash = CASE
          WHEN test_runs.drifted_at IS NULL AND EXCLUDED.previous_source_payload_hash <> '' THEN EXCLUDED.previous_source_payload_hash
          ELSE test_runs.previous_source_payload_hash
        END
    `,
    [JSON.stringify(rows)]
  );
}

async function assignPersistentTestIds(sql, records) {
  if (!records.length) return;
  for (const record of records) {
    record.contentHash = record.contentHash || testContentHash(record);
  }

  const allAliases = Array.from(new Set(records.flatMap(identityAliases)));
  const aliasToTestId = new Map();
  const aliasTargets = new Map();
  const aliasBatchSize = 500;
  for (let index = 0; index < allAliases.length; index += aliasBatchSize) {
    const batch = allAliases.slice(index, index + aliasBatchSize);
    const rows = await sql.query(
      `
        SELECT
          tia.alias_value,
          tia.test_id,
          lt.video_id,
          lt.test_type,
          lt.content_hash
        FROM test_identity_aliases tia
        JOIN logical_tests lt ON lt.test_id = tia.test_id
        WHERE tia.active = TRUE
          AND tia.alias_value = ANY($1::text[])
      `,
      [batch]
    );
    for (const row of rows) {
      aliasToTestId.set(row.alias_value, row.test_id);
      aliasTargets.set(row.alias_value, {
        testId: row.test_id,
        videoId: row.video_id,
        testType: row.test_type,
        contentHash: row.content_hash
      });
    }
  }

  const videoIds = Array.from(new Set(records.map((record) => record.videoId).filter(Boolean)));
  const existingTests = videoIds.length
    ? await sql.query(
        `
          SELECT test_id, video_id, test_type, content_hash, created_at
          FROM logical_tests
          WHERE video_id = ANY($1::text[])
        `,
        [videoIds]
      )
    : [];
  const normalizedTests = existingTests.map((row) => ({
    testId: row.test_id,
    videoId: row.video_id,
    testType: row.test_type,
    contentHash: row.content_hash,
    startDate: ""
  }));

  for (const record of records) {
    if (!record.testId) {
      const resolved = resolvePersistedTestId({
        record,
        aliasToTestId,
        aliasTargets,
        existingTests: normalizedTests
      });
      if (resolved.ambiguous || !resolved.testId) {
        const error = new Error(
          `Stable identity is ambiguous for ${record.videoId || record.videoTitle || record.testRunId}.`
        );
        error.code = "ambiguous_test_identity";
        error.identityConflict = {
          videoId: record.videoId || "",
          testType: record.testType || "",
          spreadsheetId: record.spreadsheetId || "",
          sheetName: record.sheetName || "",
          rowNumber: Number(record.rowNumber || 0),
          aliases: resolved.aliases || [],
          conflictingTestIds: resolved.conflictingTestIds || []
        };
        throw error;
      }
      record.testId = resolved.testId;
      record.identityMatch = resolved.match;
    } else {
      record.identityMatch = "existing_source_link";
    }
    for (const alias of identityAliases(record)) {
      aliasToTestId.set(alias, record.testId);
      aliasTargets.set(alias, {
        testId: record.testId,
        videoId: record.videoId || "",
        testType: record.testType || "",
        contentHash: record.contentHash || ""
      });
    }
    normalizedTests.push({
      testId: record.testId,
      videoId: record.videoId || "",
      testType: record.testType || "",
      contentHash: record.contentHash,
      startDate: record.startDate || ""
    });
  }

  const logicalRows = bestLogicalRows(records);
  await sql.query(
    `
      INSERT INTO logical_tests (
        test_id, primary_test_run_id, video_id, test_type, source_kind,
        lifecycle_status, data_quality_flag, result, result_evidence,
        result_semantics_version, explicit_winner_variant, highest_share_variant,
        operational_decision, youtube_applied_variant, inconclusive_reason,
        inconclusive_reason_evidence, content_hash, updated_at
      )
      SELECT
        item.test_id,
        item.test_run_id,
        item.video_id,
        item.test_type,
        item.source_kind,
        item.lifecycle_status,
        item.data_quality_flag,
        item.result,
        item.result_evidence,
        item.result_semantics_version,
        item.explicit_winner_variant,
        item.highest_share_variant,
        item.operational_decision,
        item.youtube_applied_variant,
        item.inconclusive_reason,
        item.inconclusive_reason_evidence,
        item.content_hash,
        NOW()
      FROM jsonb_to_recordset($1::jsonb) AS item(
        test_id text,
        test_run_id text,
        video_id text,
        test_type text,
        source_kind text,
        lifecycle_status text,
        data_quality_flag text,
        result text,
        result_evidence text,
        result_semantics_version text,
        explicit_winner_variant text,
        highest_share_variant text,
        operational_decision text,
        youtube_applied_variant text,
        inconclusive_reason text,
        inconclusive_reason_evidence text,
        content_hash text
      )
      ON CONFLICT (test_id)
      DO UPDATE SET
        primary_test_run_id = CASE
          WHEN logical_tests.primary_test_run_id = '' THEN EXCLUDED.primary_test_run_id
          ELSE logical_tests.primary_test_run_id
        END,
        video_id = CASE WHEN EXCLUDED.video_id <> '' THEN EXCLUDED.video_id ELSE logical_tests.video_id END,
        test_type = CASE WHEN EXCLUDED.test_type <> '' THEN EXCLUDED.test_type ELSE logical_tests.test_type END,
        source_kind = CASE WHEN EXCLUDED.source_kind <> '' THEN EXCLUDED.source_kind ELSE logical_tests.source_kind END,
        lifecycle_status = CASE
          WHEN logical_tests.lifecycle_status = 'unknown' THEN EXCLUDED.lifecycle_status
          ELSE logical_tests.lifecycle_status
        END,
        data_quality_flag = EXCLUDED.data_quality_flag,
        result = CASE
          WHEN logical_tests.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN logical_tests.result
          ELSE EXCLUDED.result
        END,
        result_evidence = CASE
          WHEN logical_tests.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN logical_tests.result_evidence
          ELSE EXCLUDED.result_evidence
        END,
        result_semantics_version = EXCLUDED.result_semantics_version,
        explicit_winner_variant = CASE
          WHEN logical_tests.explicit_winner_variant <> '' THEN logical_tests.explicit_winner_variant
          ELSE EXCLUDED.explicit_winner_variant
        END,
        highest_share_variant = EXCLUDED.highest_share_variant,
        operational_decision = CASE
          WHEN logical_tests.operational_decision <> '' THEN logical_tests.operational_decision
          ELSE EXCLUDED.operational_decision
        END,
        youtube_applied_variant = CASE
          WHEN EXCLUDED.youtube_applied_variant <> '' THEN EXCLUDED.youtube_applied_variant
          ELSE logical_tests.youtube_applied_variant
        END,
        inconclusive_reason = CASE
          WHEN logical_tests.result_evidence IN ('studio_explicit', 'sheet_explicit')
            THEN logical_tests.inconclusive_reason
          ELSE EXCLUDED.inconclusive_reason
        END,
        inconclusive_reason_evidence = CASE
          WHEN logical_tests.result_evidence IN ('studio_explicit', 'sheet_explicit')
            THEN logical_tests.inconclusive_reason_evidence
          ELSE EXCLUDED.inconclusive_reason_evidence
        END,
        content_hash = EXCLUDED.content_hash,
        updated_at = NOW()
    `,
    [JSON.stringify(logicalRows)]
  );
}

function bestLogicalRows(records) {
  const byTestId = new Map();
  for (const record of records) {
    const candidate = {
      test_id: record.testId,
      test_run_id: record.testRunId,
      video_id: record.videoId || "",
      test_type: record.testType || "",
      source_kind: record.sourceKind || "",
      lifecycle_status:
        record.finishDate || record.status === "result_logged" || record.status === "sheet_marked_done"
          ? "finished"
          : "unknown",
      data_quality_flag:
        !record.startDate &&
        !record.finishDate &&
        record.status !== "result_logged" &&
        record.status !== "sheet_marked_done"
          ? "missing_start_and_finish_evidence"
          : "",
      result: record.result || "unknown",
      result_evidence: record.resultEvidence || "unknown",
      result_semantics_version: record.resultSemanticsVersion || "",
      explicit_winner_variant: record.explicitWinnerVariant || "",
      highest_share_variant: record.highestShareVariant || "",
      operational_decision: record.operationalDecision || "",
      youtube_applied_variant: record.youtubeAppliedVariant || "",
      inconclusive_reason: record.inconclusiveReason || "",
      inconclusive_reason_evidence: record.inconclusiveReasonEvidence || "",
      content_hash: record.contentHash || testContentHash(record)
    };
    const current = byTestId.get(record.testId);
    if (!current || logicalResultPriority(candidate) > logicalResultPriority(current)) {
      byTestId.set(record.testId, candidate);
    }
  }
  return Array.from(byTestId.values());
}

function logicalResultPriority(record) {
  return (
    ({ studio_explicit: 40, sheet_explicit: 30, inferred_legacy: 10, unknown: 0 }[
      record.result_evidence
    ] || 0) +
    (record.result !== "unknown" ? 5 : 0) +
    (record.video_id ? 2 : 0)
  );
}

async function persistIdentityLinks(sql, rows) {
  if (!rows.length) return;
  const links = rows
    .filter((row) => row.test_id)
    .map((row) => ({
      test_run_id: row.test_run_id,
      test_id: row.test_id,
      linkage_method: row.identity_match || "scan_assignment",
      linkage_confidence: "deterministic"
    }));
  if (!links.length) return;
  await sql.query(
    `
      INSERT INTO test_source_links (
        test_run_id, test_id, linkage_method, linkage_confidence, updated_at
      )
      SELECT
        item.test_run_id,
        item.test_id,
        item.linkage_method,
        item.linkage_confidence,
        NOW()
      FROM jsonb_to_recordset($1::jsonb) AS item(
        test_run_id text,
        test_id text,
        linkage_method text,
        linkage_confidence text
      )
      ON CONFLICT (test_run_id)
      DO UPDATE SET
        test_id = EXCLUDED.test_id,
        linkage_method = EXCLUDED.linkage_method,
        linkage_confidence = EXCLUDED.linkage_confidence,
        updated_at = NOW()
    `,
    [JSON.stringify(links)]
  );

  const aliases = [];
  for (const row of rows) {
    for (const aliasValue of identityAliases({
      ...row,
      testId: row.test_id,
      testRunId: row.test_run_id,
      sourceKind: row.source_kind,
      spreadsheetId: row.spreadsheet_id,
      sheetName: row.sheet_name,
      rowNumber: row.row_number,
      videoId: row.video_id,
      testType: row.test_type,
      startDate: row.start_date,
      options: row.options,
      contentHash: row.content_hash
    })) {
      aliases.push({
        alias_id: `alias_${crypto.createHash("sha1").update(aliasValue).digest("hex")}`,
        test_id: row.test_id,
        alias_type: aliasValue.split(":", 1)[0],
        alias_value: aliasValue
      });
    }
  }
  const uniqueAliases = dedupeIdentityAliasesForPersistence(aliases);
  if (uniqueAliases.length) {
    // Sheet locations are mutable because collaborators insert and delete rows.
    // Content and dated-video aliases remain immutable and never change owners.
    await sql.query(
      `
        INSERT INTO test_identity_aliases (
          alias_id, test_id, alias_type, alias_value, last_seen_at, active
        )
        SELECT
          item.alias_id,
          item.test_id,
          item.alias_type,
          item.alias_value,
          NOW(),
          TRUE
        FROM jsonb_to_recordset($1::jsonb) AS item(
          alias_id text,
          test_id text,
          alias_type text,
          alias_value text
        )
        ON CONFLICT (alias_value)
        DO UPDATE SET
          test_id = CASE
            WHEN EXCLUDED.alias_type = 'sheet' THEN EXCLUDED.test_id
            ELSE test_identity_aliases.test_id
          END,
          last_seen_at = NOW(),
          active = TRUE
        WHERE test_identity_aliases.test_id = EXCLUDED.test_id
           OR EXCLUDED.alias_type = 'sheet'
      `,
      [JSON.stringify(uniqueAliases)]
    );
  }

  const history = rows
    .filter((row) => row.test_id)
    .map((row) => ({
      history_id: `idh_${crypto
        .createHash("sha1")
        .update(`scan|${row.test_id}|${row.test_run_id}|${row.content_hash || ""}`)
        .digest("hex")}`,
      test_id: row.test_id,
      test_run_id: row.test_run_id,
      event_type:
        row.identity_match === "new"
          ? "identity_assigned"
          : "source_linked",
      old_value: {},
      new_value: {
        testId: row.test_id,
        contentHash: row.content_hash || ""
      },
      reason: `Scanner identity match: ${row.identity_match || "scan_assignment"}`
    }));
  if (history.length) {
    await sql.query(
      `
        INSERT INTO test_id_history (
          history_id, test_id, test_run_id, event_type, old_value, new_value,
          reason, migration_id
        )
        SELECT
          item.history_id,
          item.test_id,
          item.test_run_id,
          item.event_type,
          item.old_value,
          item.new_value,
          item.reason,
          ''
        FROM jsonb_to_recordset($1::jsonb) AS item(
          history_id text,
          test_id text,
          test_run_id text,
          event_type text,
          old_value jsonb,
          new_value jsonb,
          reason text
        )
        ON CONFLICT (history_id) DO NOTHING
      `,
      [JSON.stringify(history)]
    );
  }
}

async function reuseExistingRunIds(sql, records) {
  const spreadsheetIds = Array.from(new Set(records.map((record) => record.spreadsheetId).filter(Boolean)));
  if (!spreadsheetIds.length) return;
  const rows = await sql.query(
    `
      SELECT
        tr.test_run_id,
        tr.test_id,
        tr.content_hash,
        tr.source_kind,
        tr.spreadsheet_id,
        tr.sheet_name,
        tr.row_number,
        tr.video_id,
        tr.start_date,
        tr.option_fingerprint,
        tr.updated_at,
        EXISTS (
          SELECT 1 FROM test_actions ta
          WHERE ta.test_run_id = tr.test_run_id AND ta.undone_at IS NULL
        ) AS has_action
      FROM test_runs tr
      WHERE tr.spreadsheet_id = ANY($1::text[])
      ORDER BY has_action DESC, tr.updated_at DESC
    `,
    [spreadsheetIds]
  );
  const byNaturalKey = new Map();
  for (const row of rows) {
    const key = naturalRunKey({
      sourceKind: row.source_kind,
      spreadsheetId: row.spreadsheet_id,
      sheetName: row.sheet_name,
      rowNumber: row.row_number,
      videoId: row.video_id,
      startDate: formatDateOnly(row.start_date),
      optionFingerprint: row.option_fingerprint
    });
    if (!byNaturalKey.has(key)) {
      byNaturalKey.set(key, {
        testRunId: row.test_run_id,
        testId: row.test_id || "",
        contentHash: row.content_hash || ""
      });
    }
  }
  for (const record of records) {
    const existing = byNaturalKey.get(naturalRunKey(record));
    if (existing) {
      record.testRunId = existing.testRunId;
      record.testId = existing.testId;
      if (existing.contentHash) record.contentHash = existing.contentHash;
    }
  }
}

function naturalRunKey(record) {
  return [
    record.sourceKind || "",
    record.spreadsheetId || "",
    record.sheetName || "",
    Number(record.rowNumber || 0),
    record.videoId || "",
    formatDateOnly(record.startDate),
    record.optionFingerprint || ""
  ].join("|");
}

async function loadExistingRunState(sql, testRunIds) {
  const uniqueIds = Array.from(new Set(testRunIds.filter(Boolean)));
  const map = new Map();
  const batchSize = 500;
  for (let index = 0; index < uniqueIds.length; index += batchSize) {
    const batch = uniqueIds.slice(index, index + batchSize);
    const rows = await sql.query(
      `
        SELECT tr.test_run_id,
               tr.video_id,
               tr.source_payload_hash,
               tr.drifted_at,
               EXISTS (
                 SELECT 1 FROM test_actions ta
                 WHERE ta.test_run_id = tr.test_run_id AND ta.undone_at IS NULL
               ) AS has_action
        FROM test_runs tr
        WHERE tr.test_run_id = ANY($1::text[])
      `,
      [batch]
    );
    for (const row of rows) {
      map.set(row.test_run_id, row);
    }
  }
  return map;
}

export async function recordAppliedChangeEvents(records = []) {
  await ensureSchema();
  const inserted = [];
  for (const record of records) {
    const event = detectAppliedChange(record);
    if (!event) continue;
    const row = await insertFinishEvent({
      event,
      testRunId: record.testRunId,
      matchedConfidence: "metadata_exact",
      processingStatus: "matched",
      actorName: "system"
    });
    if (row) inserted.push(event);
  }
  return inserted;
}

export async function reconcileMissingRuns({ scanId, sourceKinds }) {
  await ensureSchema();
  const sql = getSql();
  for (const sourceKind of sourceKinds) {
    await sql`
      UPDATE test_runs tr
      SET status = 'source_removed',
          drift_reason = CASE WHEN tr.drift_reason = '' THEN 'source_removed' ELSE tr.drift_reason END,
          updated_at = NOW()
      WHERE tr.source_kind = ${sourceKind}
        AND tr.last_seen_scan_id IS DISTINCT FROM ${scanId}
        AND NOT EXISTS (
          SELECT 1 FROM test_actions ta
          WHERE ta.test_run_id = tr.test_run_id AND ta.undone_at IS NULL
        )
    `;
    await sql`
      UPDATE test_runs tr
      SET status = 'source_removed',
          drifted_at = COALESCE(tr.drifted_at, NOW()),
          drift_reason = CASE WHEN tr.drift_reason = '' THEN 'source_missing_after_done' ELSE tr.drift_reason END
      WHERE tr.source_kind = ${sourceKind}
        AND tr.last_seen_scan_id IS DISTINCT FROM ${scanId}
        AND EXISTS (
          SELECT 1 FROM test_actions ta
          WHERE ta.test_run_id = tr.test_run_id AND ta.undone_at IS NULL
        )
    `;
  }
}

export async function loadThumbnailPreviewMap() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT source_kind, sheet_name, row_number, option_key, url
    FROM thumbnail_previews
    WHERE url NOT LIKE 'data:%'
  `;
  const map = new Map();
  for (const row of rows) {
    map.set(previewKey(row.source_kind, row.sheet_name, row.row_number, row.option_key), row.url);
  }
  return map;
}

export function previewKey(sourceKind, sheetName, rowNumber, option) {
  return `${sourceKind}|${sheetName}|${rowNumber}|${option}`;
}

export async function listQueue() {
  await ensureSchema();
  const sql = getSql();
  const coverage = await activeConnectorCoverage();
  const rows = await sql`
    WITH direct_latest_action AS (
      SELECT DISTINCT ON (test_run_id)
        test_run_id AS source_test_run_id,
        action_id,
        action,
        actor_name,
        created_at
      FROM test_actions
      WHERE undone_at IS NULL
      ORDER BY test_run_id, created_at DESC
    ),
    latest_action AS (
      SELECT DISTINCT ON (target.test_run_id)
        target.test_run_id,
        direct.action_id,
        direct.action,
        direct.actor_name,
        direct.created_at
      FROM test_runs target
      JOIN test_runs source
        ON source.test_run_id = target.test_run_id
        OR (
          source.test_id IS NOT NULL
          AND target.test_id IS NOT NULL
          AND source.test_id = target.test_id
        )
        OR (
          source.video_id <> ''
          AND source.video_id = target.video_id
          AND source.test_type = target.test_type
          AND source.start_date IS NOT DISTINCT FROM target.start_date
          AND source.option_fingerprint <> ''
          AND source.option_fingerprint = target.option_fingerprint
        )
        OR (
          source.video_id <> ''
          AND source.video_id = target.video_id
          AND source.test_type = target.test_type
          AND source.option_fingerprint <> ''
          AND source.option_fingerprint = target.option_fingerprint
          AND target.start_date IS NULL
          AND target.status = 'missing_data'
        )
        OR (
          source.source_kind = 'app_registry'
          AND target.source_kind = 'app_registry'
          AND source.test_type = target.test_type
          AND (
            (
              source.video_id <> ''
              AND source.video_id = target.video_id
            )
            OR (
              LOWER(TRIM(COALESCE(NULLIF(source.current_youtube_title, ''), source.video_title))) =
                LOWER(TRIM(COALESCE(NULLIF(target.current_youtube_title, ''), target.video_title)))
              AND LOWER(TRIM(COALESCE(NULLIF(source.current_youtube_title, ''), source.video_title))) <> ''
              AND (
                source.youtube_channel_id = target.youtube_channel_id
                OR source.youtube_channel_id = ''
                OR target.youtube_channel_id = ''
                OR LOWER(TRIM(source.channel)) = LOWER(TRIM(target.channel))
                OR LOWER(TRIM(source.channel)) IN ('', 'unknown source')
                OR LOWER(TRIM(target.channel)) IN ('', 'unknown source')
              )
            )
          )
        )
      JOIN direct_latest_action direct ON direct.source_test_run_id = source.test_run_id
      ORDER BY target.test_run_id, (source.test_run_id = target.test_run_id) DESC, direct.created_at DESC
    ),
    direct_latest_event AS (
        SELECT DISTINCT ON (test_run_id)
          test_run_id AS source_test_run_id,
          test_id,
          event_id,
          video_id,
          source,
          raw_text,
          notification_url,
          channel_id,
          notification_age,
          matched_confidence,
          detected_outcome,
          processing_status,
          result,
          result_evidence,
          occurred_at,
          observed_at
      FROM finish_events
      WHERE test_run_id <> ''
        AND processing_status = 'matched'
        AND (
          source = 'metadata'
          OR (
            detected_outcome <> 'unknown'
            AND raw_text NOT ILIKE '%a/b test running%'
            AND raw_text NOT ILIKE '%ab test running%'
            AND raw_text NOT ILIKE '%test running%'
            AND raw_text NOT ILIKE '%running… get suggestions%'
          )
        )
      ORDER BY test_run_id,
        CASE
          WHEN source <> 'metadata'
            AND result_evidence = 'studio_explicit'
            AND result IN ('winner', 'performed_same', 'inconclusive')
            THEN 0
          WHEN source <> 'metadata'
            AND detected_outcome NOT IN ('', 'unknown', 'finished_unknown')
            THEN 1
          WHEN source <> 'metadata' THEN 2
          ELSE 3
        END,
        CASE
          WHEN raw_text ~* '(we updated your video to use the winner|results? with very similar performance|not enough (views|impressions)( to (determine|declare) a winner)?|(the )?test completed with no winner)[.!]?$'
            THEN 0
          WHEN raw_text ~* 'we updated your video|results? with very similar performance|not enough (views|impressions)|completed with no winner'
            THEN 1
          ELSE 2
        END,
        CASE WHEN notification_age <> '' THEN 0 ELSE 1 END,
        observed_at DESC
    ),
    latest_event AS (
      SELECT DISTINCT ON (target.test_run_id)
        target.test_run_id,
        direct.event_id,
        direct.video_id,
        direct.source,
        direct.raw_text,
        direct.notification_url,
        direct.channel_id,
        direct.notification_age,
        direct.matched_confidence,
        direct.detected_outcome,
        direct.processing_status,
        direct.occurred_at,
        direct.observed_at
      FROM test_runs target
      JOIN direct_latest_event direct
        ON direct.source_test_run_id = target.test_run_id
        OR (
          direct.test_id IS NOT NULL
          AND target.test_id IS NOT NULL
          AND direct.test_id = target.test_id
        )
      ORDER BY target.test_run_id,
        CASE
          WHEN direct.source <> 'metadata'
            AND direct.result_evidence = 'studio_explicit'
            AND direct.result IN ('winner', 'performed_same', 'inconclusive')
            THEN 0
          WHEN direct.source <> 'metadata'
            AND direct.detected_outcome NOT IN ('', 'unknown', 'finished_unknown')
            THEN 1
          WHEN direct.source <> 'metadata' THEN 2
          ELSE 3
        END,
        (direct.source_test_run_id = target.test_run_id) DESC,
        direct.observed_at DESC
    )
    SELECT
      tr.test_run_id,
      tr.test_id,
      tr.video_id,
      tr.source_kind,
      tr.spreadsheet_id,
      tr.sheet_name,
      tr.row_number,
      tr.test_type,
      tr.channel,
      tr.video_title,
      tr.video_url,
      tr.studio_url,
      tr.start_date,
      tr.finish_date,
      tr.effective_finish_date,
      tr.overdue_days,
      tr.status,
      tr.detected_outcome,
      tr.suggested_winner,
      tr.winner_reason,
      COALESCE(lt.result, tr.result, 'unknown') AS result,
      COALESCE(lt.result_evidence, tr.result_evidence, 'unknown') AS result_evidence,
      COALESCE(lt.result_semantics_version, tr.result_semantics_version, '') AS result_semantics_version,
      COALESCE(lt.explicit_winner_variant, tr.explicit_winner_variant, '') AS explicit_winner_variant,
      COALESCE(lt.highest_share_variant, tr.highest_share_variant, '') AS highest_share_variant,
      COALESCE(lt.operational_decision, tr.operational_decision, '') AS operational_decision,
      COALESCE(lt.youtube_applied_variant, tr.youtube_applied_variant, '') AS youtube_applied_variant,
      COALESCE(lt.inconclusive_reason, tr.inconclusive_reason, '') AS inconclusive_reason,
      COALESCE(lt.inconclusive_reason_evidence, tr.inconclusive_reason_evidence, '') AS inconclusive_reason_evidence,
      tr.options,
        tr.watch_time_share,
        tr.troubles,
        tr.thumbnail_previews,
        tr.current_youtube_title,
        tr.current_youtube_thumbnail_url,
        tr.youtube_channel_id,
        tr.youtube_channel_title,
      tr.youtube_channel_thumbnail_url,
      tr.option_fingerprint,
      tr.row_fingerprint,
      tr.first_seen_at,
      tr.updated_at,
      tr.last_seen_scan_id,
      tr.possible_retest,
      tr.drifted_at,
      tr.drift_reason,
      tr.previous_source_payload_hash,
      la.action AS latest_action,
      la.actor_name AS latest_actor,
      la.created_at AS latest_action_at,
        le.event_id AS finish_event_id,
        le.video_id AS finish_event_video_id,
        le.source AS finish_event_source,
        le.raw_text AS finish_event_text,
        le.notification_url AS finish_event_url,
        le.channel_id AS finish_event_channel_id,
        le.notification_age AS finish_event_notification_age,
        le.matched_confidence AS matched_confidence,
      le.detected_outcome AS finish_event_outcome,
      le.processing_status AS finish_event_processing_status,
      le.occurred_at AS finish_event_occurred_at,
      le.observed_at AS finish_event_at
    FROM test_runs tr
    LEFT JOIN logical_tests lt ON lt.test_id = tr.test_id
    LEFT JOIN latest_action la ON la.test_run_id = tr.test_run_id
    LEFT JOIN latest_event le ON le.test_run_id = tr.test_run_id
    LEFT JOIN review_resolutions rr
      ON rr.target_type = 'test_run'
      AND rr.target_id = tr.test_run_id
      AND rr.action = 'ignore'
      AND rr.undone_at IS NULL
    WHERE tr.status <> 'source_removed'
      AND NOT (
        tr.start_date > CURRENT_DATE
        AND tr.finish_date IS NULL
        AND tr.status IN ('running', 'scheduled')
        AND le.event_id IS NULL
        AND la.action IS NULL
      )
      AND NOT (
        tr.start_date < DATE '2005-01-01'
        AND tr.status IN ('running', 'scheduled', 'missing_data')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM test_runs closed_copy
        WHERE closed_copy.test_run_id <> tr.test_run_id
          AND (
            (
              closed_copy.test_id IS NOT NULL
              AND tr.test_id IS NOT NULL
              AND closed_copy.test_id = tr.test_id
            )
            OR (
              closed_copy.video_id <> ''
              AND closed_copy.video_id = tr.video_id
              AND closed_copy.test_type = tr.test_type
              AND closed_copy.start_date IS NOT DISTINCT FROM tr.start_date
              AND closed_copy.option_fingerprint <> ''
              AND closed_copy.option_fingerprint = tr.option_fingerprint
            )
          )
          AND closed_copy.status IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
      )
      AND (
      rr.resolution_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM test_runs ignored_source
        JOIN review_resolutions ignored_resolution
          ON ignored_resolution.target_type = 'test_run'
          AND ignored_resolution.target_id = ignored_source.test_run_id
          AND ignored_resolution.action = 'ignore'
          AND ignored_resolution.undone_at IS NULL
        WHERE ignored_source.test_type = tr.test_type
          AND (
            (
              tr.source_kind IN ('title', 'thumbnail')
              AND ignored_source.source_kind = tr.source_kind
              AND ignored_source.video_id <> ''
              AND ignored_source.video_id = tr.video_id
              AND ignored_source.start_date IS NOT DISTINCT FROM tr.start_date
              AND ignored_source.option_fingerprint <> ''
              AND ignored_source.option_fingerprint = tr.option_fingerprint
            )
            OR (
              tr.source_kind = 'app_registry'
              AND ignored_source.source_kind = 'app_registry'
              AND (
                (
                  ignored_source.video_id <> ''
                  AND ignored_source.video_id = tr.video_id
                )
                OR (
                  LOWER(TRIM(COALESCE(NULLIF(ignored_source.current_youtube_title, ''), ignored_source.video_title))) =
                    LOWER(TRIM(COALESCE(NULLIF(tr.current_youtube_title, ''), tr.video_title)))
                  AND LOWER(TRIM(COALESCE(NULLIF(ignored_source.current_youtube_title, ''), ignored_source.video_title))) <> ''
                  AND (
                    ignored_source.youtube_channel_id = tr.youtube_channel_id
                    OR ignored_source.youtube_channel_id = ''
                    OR tr.youtube_channel_id = ''
                    OR LOWER(TRIM(ignored_source.channel)) = LOWER(TRIM(tr.channel))
                    OR LOWER(TRIM(ignored_source.channel)) IN ('', 'unknown source')
                    OR LOWER(TRIM(tr.channel)) IN ('', 'unknown source')
                  )
                )
              )
            )
          )
      )
      AND (
        (
          la.action IS NULL
          AND tr.status NOT IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
        )
        OR (
          la.action IS NOT NULL
          AND tr.drifted_at IS NOT NULL
          AND tr.status NOT IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
        )
        OR (
          la.action IN ('A', 'B', 'C', 'NO_CLEAR')
          AND tr.status IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
        )
      )
    )
      AND (
        tr.source_kind <> 'app_registry'
        OR le.event_id IS NOT NULL
      )
    ORDER BY LOWER(tr.channel), tr.finish_date DESC NULLS LAST, tr.updated_at DESC, tr.row_number
    LIMIT 1000
  `;
  return dedupeQueueRuns(rows
    .map((row) => applyConnectorCoverage(runRow(row), coverage))
    .filter(activeQueueRun));
}

export async function cleanupInlineThumbnailData() {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM thumbnail_previews WHERE url LIKE 'data:%'`;
  await sql`
    UPDATE test_runs
    SET thumbnail_previews = '{}'::jsonb
    WHERE thumbnail_previews::text LIKE '%data:%'
  `;
}

export async function listHistory({ search = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const term = `%${String(search || "").toLowerCase()}%`;
  const rows = await sql`
    SELECT
      tr.test_run_id,
      tr.test_id,
      tr.video_id,
      tr.source_kind,
      tr.spreadsheet_id,
      tr.sheet_name,
      tr.row_number,
      tr.test_type,
      tr.channel,
      tr.video_title,
      tr.video_url,
      tr.studio_url,
      tr.start_date,
      tr.finish_date,
      tr.effective_finish_date,
      tr.overdue_days,
      tr.status,
      tr.detected_outcome,
      tr.suggested_winner,
      tr.winner_reason,
      COALESCE(lt.result, tr.result, 'unknown') AS result,
      COALESCE(lt.result_evidence, tr.result_evidence, 'unknown') AS result_evidence,
      COALESCE(lt.result_semantics_version, tr.result_semantics_version, '') AS result_semantics_version,
      COALESCE(lt.explicit_winner_variant, tr.explicit_winner_variant, '') AS explicit_winner_variant,
      COALESCE(lt.highest_share_variant, tr.highest_share_variant, '') AS highest_share_variant,
      COALESCE(lt.operational_decision, tr.operational_decision, '') AS operational_decision,
      COALESCE(lt.youtube_applied_variant, tr.youtube_applied_variant, '') AS youtube_applied_variant,
      COALESCE(lt.inconclusive_reason, tr.inconclusive_reason, '') AS inconclusive_reason,
      COALESCE(lt.inconclusive_reason_evidence, tr.inconclusive_reason_evidence, '') AS inconclusive_reason_evidence,
      tr.options,
        tr.watch_time_share,
        tr.troubles,
        tr.thumbnail_previews,
        tr.current_youtube_title,
        tr.current_youtube_thumbnail_url,
        tr.youtube_channel_id,
        tr.youtube_channel_title,
      tr.youtube_channel_thumbnail_url,
      tr.option_fingerprint,
      tr.row_fingerprint,
      tr.first_seen_at,
      tr.updated_at,
      tr.last_seen_scan_id,
      tr.possible_retest,
      tr.drifted_at,
      tr.drift_reason,
      tr.previous_source_payload_hash,
      ta.action_id,
      ta.action,
      ta.actor_name,
      ta.note,
      ta.retest_confirmed,
      ta.created_at AS action_created_at,
      ta.undone_at,
      ta.undone_by
    FROM test_actions ta
    JOIN test_runs tr ON tr.test_run_id = ta.test_run_id
    LEFT JOIN logical_tests lt ON lt.test_id = tr.test_id
    WHERE ${!search} OR LOWER(CONCAT(tr.video_title, ' ', tr.channel, ' ', tr.video_id, ' ', ta.action, ' ', ta.actor_name)) LIKE ${term}
    ORDER BY ta.created_at DESC
  `;
  return rows.map((row) => ({
    ...runRow(row),
    action: {
      actionId: row.action_id,
      action: row.action,
      actorName: row.actor_name,
      note: row.note || "",
      retestConfirmed: Boolean(row.retest_confirmed),
      createdAt: row.action_created_at,
      undoneAt: row.undone_at || "",
      undoneBy: row.undone_by || ""
    }
  }));
}

export async function getTestRun(testRunId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT tr.*,
      (
        SELECT json_agg(row_to_json(ta) ORDER BY ta.created_at DESC)
        FROM test_actions ta
        WHERE ta.test_run_id = tr.test_run_id
          AND ta.undone_at IS NULL
      ) AS actions,
      (
        SELECT json_agg(row_to_json(fe) ORDER BY fe.observed_at DESC)
        FROM finish_events fe
        WHERE fe.test_run_id = tr.test_run_id
      ) AS finish_events
    FROM test_runs tr
    WHERE tr.test_run_id = ${testRunId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    ...runRow(rows[0]),
    actions: fromJson(rows[0].actions, []),
    finishEvents: fromJson(rows[0].finish_events, [])
  };
}

export async function listRunsForVideo(videoId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT tr.*
    FROM test_runs tr
    WHERE tr.video_id = ${videoId}
    ORDER BY tr.effective_finish_date DESC NULLS LAST, tr.updated_at DESC
  `;
  return rows.map(runRow);
}

export async function completeTestRun({
  testRunId,
  action,
  actorName,
  note,
  retestConfirmed,
  replacePrevious = false
}) {
  await ensureSchema();
  const sql = getSql();
  const existing = await sql`
    SELECT tr.test_run_id,
      tr.test_id,
      (
        SELECT ta.action
        FROM test_actions ta
        WHERE (
            ta.test_run_id = tr.test_run_id
            OR (tr.test_id IS NOT NULL AND ta.test_id = tr.test_id)
          )
          AND ta.undone_at IS NULL
        ORDER BY ta.created_at DESC
        LIMIT 1
      ) AS latest_action,
      (
        SELECT ta.action_id
        FROM test_actions ta
        WHERE (
            ta.test_run_id = tr.test_run_id
            OR (tr.test_id IS NOT NULL AND ta.test_id = tr.test_id)
          )
          AND ta.undone_at IS NULL
        ORDER BY ta.created_at DESC
        LIMIT 1
      ) AS latest_action_id
    FROM test_runs tr
    WHERE tr.test_run_id = ${testRunId}
    LIMIT 1
  `;
  if (!existing[0]) {
    const error = new Error("Test run not found. Refresh the queue and try again.");
    error.status = 404;
    throw error;
  }
  if (existing[0].latest_action === action) {
    const test = await getTestRun(testRunId);
    return {
      test,
      actionId: existing[0].latest_action_id || "",
      duplicate: true,
      corrected: false
    };
  }
  const previousActions = replacePrevious ? await sql`
    SELECT action_id, action
    FROM test_actions
    WHERE (
        test_run_id = ${testRunId}
        OR (${existing[0].test_id || null}::text IS NOT NULL AND test_id = ${existing[0].test_id || null})
      )
      AND undone_at IS NULL
      AND action <> ${action}
    ORDER BY created_at DESC
  ` : [];
  const supersededActionIds = previousActions.map((item) => item.action_id);
  const actionId = crypto.randomUUID();
  await sql.transaction((txn) => {
    const queries = [];
    if (supersededActionIds.length) {
      queries.push(txn`
        UPDATE test_actions
        SET undone_at = NOW(),
            undone_by = ${actorName || "Reviewer"}
        WHERE action_id IN (
          SELECT jsonb_array_elements_text(${JSON.stringify(supersededActionIds)}::jsonb)
        )
          AND undone_at IS NULL
      `);
    }
    queries.push(txn`
      INSERT INTO test_actions (
        action_id,
        test_run_id,
        test_id,
        action,
        actor_name,
        note,
        retest_confirmed,
        metadata
      )
      VALUES (
        ${actionId},
        ${testRunId},
        ${existing[0].test_id || null},
        ${action},
        ${actorName || "Reviewer"},
        ${note || ""},
        ${Boolean(retestConfirmed)},
        ${toJson({
          source: replacePrevious ? "conflict_resolution" : "detector_modal",
          supersededActionIds,
          previousActions: previousActions.map((item) => item.action)
        })}::jsonb
      )
    `);
    if (existing[0].test_id) {
      queries.push(txn`
        UPDATE logical_tests
        SET operational_decision = ${action},
            updated_at = NOW()
        WHERE test_id = ${existing[0].test_id}
      `);
      queries.push(txn`
        UPDATE test_runs
        SET operational_decision = ${action}
        WHERE test_id = ${existing[0].test_id}
      `);
    }
    return queries;
  });
  return {
    test: await getTestRun(testRunId),
    actionId,
    duplicate: false,
    corrected: supersededActionIds.length > 0
  };
}

export async function undoTestAction({ actionId, actorName = "Reviewer" }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT ta.action_id, ta.test_run_id, tr.test_id, ta.metadata
    FROM test_actions ta
    JOIN test_runs tr ON tr.test_run_id = ta.test_run_id
    WHERE ta.action_id = ${actionId}
      AND ta.undone_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) {
    const error = new Error("This action was already undone or no longer exists.");
    error.status = 409;
    throw error;
  }
  const newer = await sql`
    SELECT action_id
    FROM test_actions
    WHERE (
        test_run_id = ${rows[0].test_run_id}
        OR (${rows[0].test_id || null}::text IS NOT NULL AND test_id = ${rows[0].test_id || null})
      )
      AND undone_at IS NULL
      AND created_at > (SELECT created_at FROM test_actions WHERE action_id = ${actionId})
    LIMIT 1
  `;
  if (newer[0]) {
    const error = new Error("A newer decision exists for this test. Correct it from History instead.");
    error.status = 409;
    throw error;
  }
  const metadata = fromJson(rows[0].metadata, {});
  const supersededActionIds = Array.isArray(metadata.supersededActionIds)
    ? metadata.supersededActionIds.map(String).filter(Boolean)
    : [];
  await sql.transaction((txn) => {
    const queries = [txn`
      UPDATE test_actions
      SET undone_at = NOW(), undone_by = ${actorName || "Reviewer"}
      WHERE action_id = ${actionId} AND undone_at IS NULL
    `];
    if (supersededActionIds.length) {
      queries.push(txn`
        UPDATE test_actions
        SET undone_at = NULL, undone_by = ''
        WHERE action_id IN (
          SELECT jsonb_array_elements_text(${JSON.stringify(supersededActionIds)}::jsonb)
        )
          AND undone_at IS NOT NULL
      `);
    }
    return queries;
  });
  const previous = await sql`
    SELECT action
    FROM test_actions
    WHERE (
        test_run_id = ${rows[0].test_run_id}
        OR (${rows[0].test_id || null}::text IS NOT NULL AND test_id = ${rows[0].test_id || null})
      )
      AND undone_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const operationalDecision = previous[0]?.action || "";
  if (rows[0].test_id) {
    await sql`
      UPDATE logical_tests
      SET operational_decision = ${operationalDecision},
          updated_at = NOW()
      WHERE test_id = ${rows[0].test_id}
    `;
    await sql`
      UPDATE test_runs
      SET operational_decision = ${operationalDecision}
      WHERE test_id = ${rows[0].test_id}
    `;
  }
  return { actionId, testRunId: rows[0].test_run_id };
}

export async function resolveReviewItem({ targetType, targetId, action = "ignore", actorName = "", note = "", metadata = {} }) {
  await ensureSchema();
  const sql = getSql();
  const resolutionId = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO review_resolutions (
      resolution_id,
      target_type,
      target_id,
      action,
      actor_name,
      note,
      metadata
    )
    VALUES (
      ${resolutionId},
      ${targetType},
      ${targetId},
      ${action},
      ${actorName || "Reviewer"},
      ${note || ""},
      ${toJson(metadata)}::jsonb
    )
    ON CONFLICT (target_type, target_id, action)
    DO UPDATE SET
      actor_name = EXCLUDED.actor_name,
      note = EXCLUDED.note,
      metadata = EXCLUDED.metadata,
      undone_at = NULL,
      undone_by = '',
      created_at = NOW()
    RETURNING resolution_id
  `;
  return { resolutionId: rows[0]?.resolution_id || resolutionId, targetType, targetId, action };
}

export async function undoReviewResolution({ resolutionId, actorName = "Reviewer" }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE review_resolutions
    SET undone_at = NOW(), undone_by = ${actorName || "Reviewer"}
    WHERE resolution_id = ${resolutionId} AND undone_at IS NULL
    RETURNING resolution_id, target_type, target_id
  `;
  if (!rows[0]) {
    const error = new Error("This action was already undone or no longer exists.");
    error.status = 409;
    throw error;
  }
  return { resolutionId, targetType: rows[0].target_type, targetId: rows[0].target_id };
}

export async function matchFinishEventToTestRun({ eventId, testRunId, actorName = "", note = "" }) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE finish_events
    SET test_run_id = ${testRunId},
        matched_confidence = 'manual',
        processing_status = 'matched',
        actor_name = ${actorName || "Reviewer"},
        updated_at = NOW()
    WHERE event_id = ${eventId}
    RETURNING event_id, test_run_id, video_id, raw_text, detected_outcome
  `;
  if (!rows[0]) {
    const error = new Error("Finish signal not found.");
    error.status = 404;
    throw error;
  }
  await resolveReviewItem({
    targetType: "finish_event",
    targetId: eventId,
    action: "match",
    actorName,
    note,
    metadata: { testRunId }
  });
  return rows[0];
}

export async function listConnectorActiveRuns() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      tr.test_run_id,
      tr.video_id,
      tr.source_kind,
      tr.sheet_name,
      tr.row_number,
      tr.test_type,
      tr.channel,
      tr.video_title,
      tr.video_url,
      tr.studio_url,
      tr.start_date,
      tr.finish_date,
      tr.status,
      tr.detected_outcome,
        tr.suggested_winner,
        tr.options,
        tr.current_youtube_title,
        tr.current_youtube_thumbnail_url,
        tr.youtube_channel_id,
        tr.youtube_channel_title,
      tr.youtube_channel_thumbnail_url,
      tr.thumbnail_previews,
      tr.updated_at
    FROM test_runs tr
    WHERE tr.status NOT IN ('scheduled', 'sheet_marked_done', 'result_logged', 'winner_found', 'no_clear', 'source_removed')
      AND (tr.start_date IS NULL OR tr.start_date <= CURRENT_DATE)
      AND (tr.start_date IS NULL OR tr.start_date >= DATE '2005-01-01')
      AND NOT EXISTS (
        SELECT 1 FROM test_actions ta
        WHERE ta.undone_at IS NULL
          AND (
            ta.test_run_id = tr.test_run_id
            OR (ta.test_id IS NOT NULL AND ta.test_id = tr.test_id)
          )
      )
    ORDER BY LOWER(tr.channel), tr.updated_at DESC
    LIMIT 1000
  `;
  return rows.map(runRow);
}

export async function listKnownYouTubeChannels() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT DISTINCT ON (youtube_channel_id)
      channel,
      youtube_channel_id,
      youtube_channel_title,
      updated_at
    FROM test_runs
    WHERE youtube_channel_id <> ''
    ORDER BY youtube_channel_id, updated_at DESC
  `;
  return rows.map((row) => ({
    channel: row.youtube_channel_title || row.channel || "",
    youtubeChannelTitle: row.youtube_channel_title || "",
    youtubeChannelId: row.youtube_channel_id || ""
  }));
}

async function listConnectorMatchRuns() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      tr.test_run_id,
      tr.video_id,
      tr.source_kind,
      tr.sheet_name,
      tr.row_number,
      tr.test_type,
      tr.channel,
      tr.video_title,
      tr.video_url,
      tr.studio_url,
      tr.start_date,
      tr.finish_date,
      tr.status,
      tr.detected_outcome,
        tr.suggested_winner,
        tr.options,
        tr.current_youtube_title,
        tr.current_youtube_thumbnail_url,
        tr.youtube_channel_id,
        tr.youtube_channel_title,
      tr.youtube_channel_thumbnail_url,
      tr.thumbnail_previews,
      tr.updated_at
    FROM test_runs tr
    WHERE tr.status NOT IN ('scheduled', 'missing_data', 'source_removed')
      AND (tr.start_date IS NULL OR tr.start_date <= CURRENT_DATE OR tr.finish_date IS NOT NULL)
      AND (tr.start_date IS NULL OR tr.start_date >= DATE '2005-01-01' OR tr.finish_date IS NOT NULL)
      AND tr.source_kind <> 'app_registry'
    ORDER BY
      CASE
        WHEN tr.status IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
          OR EXISTS (
            SELECT 1 FROM test_actions ta
            WHERE ta.test_run_id = tr.test_run_id AND ta.undone_at IS NULL
          )
        THEN 1
        ELSE 0
      END,
      LOWER(tr.channel),
      tr.updated_at DESC
    LIMIT 5000
  `;
  return rows.map(runRow);
}

export async function listFinishSignalMatchCandidates() {
  return listConnectorMatchRuns();
}

export async function recordConnectorEvents({
  events = [],
  actorName = "",
  connectorId = "",
  source = "studio_bell",
  youtubeApiKey = "",
  channelScope = [],
  testTypeScope = "all"
} = {}) {
  await ensureSchema();
  const matchRuns = await listConnectorMatchRuns();
  const scope = normalizeConnectorEventScope({ channelScope, testTypeScope });
  const results = [];
  let youtubeLookups = 0;
  for (const item of events) {
    let event = parseStudioNotification({ ...item, source: item.source || source });
    if (!isLikelyFinishNotification(event.rawText)) {
      results.push({
        eventId: "",
        testRunId: "",
        videoId: event.videoId,
        processingStatus: "ignored",
        matchedConfidence: "filtered_noise",
        detectedOutcome: event.detectedOutcome
      });
      continue;
    }
    let match = matchFinishEventToRun(event, matchRuns);
    let youtubeResolution = {
      event,
      summary: { resolved: false, reason: match.run ? "matched_local_registry" : "not_attempted" }
    };
    if (needsYouTubeResolution(match) && youtubeApiKey && youtubeLookups < 25) {
      youtubeLookups += 1;
      const resolved = await resolveFinishEventVideo(event, { youtubeApiKey });
      if (resolved.summary?.resolved || !match.run) {
        youtubeResolution = resolved;
        event = resolved.event;
        match = matchFinishEventToRun(event, matchRuns);
      }
    }
    event = alignFinishEventToMatchedRun(event, match);
    if (!connectorEventInScope({ event, run: match.run, scope })) {
      results.push({
        eventId: "",
        testRunId: match.run?.testRunId || "",
        videoId: event.videoId,
        processingStatus: "ignored",
        matchedConfidence: "out_of_selected_scope",
        detectedOutcome: event.detectedOutcome,
        youtubeResolved: Boolean(youtubeResolution.summary?.resolved)
      });
      continue;
    }
    if (!match.run && isPromotableStudioFinishEvent({
      ...event,
      youtubeResolution: youtubeResolution.summary
    })) {
      const appRun = await ensureAppManagedRun({ sql: getSql(), event, youtubeApiKey });
      if (appRun) {
        match = { run: appRun, matchedConfidence: "app_registry", score: 1 };
        matchRuns.push(appRun);
      }
    }
    event = alignFinishEventToMatchedRun(event, match);
    const matchedConfidence = resolvedMatchedConfidence(match.matchedConfidence, youtubeResolution);
    const row = await insertFinishEvent({
      event: {
        ...event,
        connectorId,
        youtubeResolution: youtubeResolution.summary
      },
      testRunId: match.run?.testRunId || "",
      matchedConfidence,
      processingStatus: match.run ? "matched" : "unmatched",
      actorName
    });
    results.push({
      eventId: row?.event_id || "",
      testRunId: match.run?.testRunId || "",
      videoId: event.videoId,
      processingStatus: match.run ? "matched" : "unmatched",
      matchedConfidence,
      detectedOutcome: event.detectedOutcome,
      youtubeResolved: Boolean(youtubeResolution.summary?.resolved)
    });
  }
  await supersedeDuplicateFinishEvents();
  await cleanupUnmatchedFinishEvents();
  return results;
}

function normalizeConnectorEventScope({ channelScope = [], testTypeScope = "all" } = {}) {
  const channels = Array.isArray(channelScope)
    ? channelScope
        .map((channel) => canonicalChannelName(channel))
        .filter(Boolean)
    : [];
  return {
    channels: Array.from(new Set(channels)),
    testType: ["title", "thumbnail"].includes(String(testTypeScope || "").toLowerCase())
      ? String(testTypeScope).toLowerCase()
      : "all"
  };
}

function connectorEventInScope({ event, run, scope }) {
  if (!scope?.channels?.length && scope?.testType === "all") return true;
  if (scope.testType !== "all" && run?.testType && run.testType !== scope.testType) return false;
  if (!scope.channels.length) return true;
  const eventChannel = canonicalChannelName(event.channel);
  const runChannel = canonicalChannelName(run?.channel || run?.youtubeChannelTitle || "");
  if (runChannel) return scope.channels.includes(runChannel);
  if (eventChannel) return scope.channels.includes(eventChannel);
  // YouTube sometimes omits the channel label from a valid bell notification.
  // Retain that signal for automatic rematching instead of silently losing it.
  return true;
}

export async function rematchUnmatchedFinishEvents({ limit = 200, youtubeApiKey = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const matchRuns = await listConnectorMatchRuns();
  const rows = await sql`
    SELECT event_id, video_id, channel_id, channel, source, raw_text, notification_url, notification_age, detected_outcome, payload, occurred_at, observed_at
    FROM finish_events
    WHERE processing_status = 'unmatched'
      AND raw_text <> ''
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `;
  const matched = [];
  let youtubeLookups = 0;
  for (const row of rows) {
    const payload = fromJson(row.payload, {});
    let event = parseStudioNotification({
      ...payload,
      source: row.source,
      rawText: row.raw_text,
      url: row.notification_url,
      videoId: row.video_id,
      channelId: row.channel_id,
      channel: row.channel,
      notificationAge: notificationAgeLabel(row.notification_age || payload.notificationAge || ""),
      occurredAt: row.occurred_at || payload.occurredAt || "",
      detectedOutcome: row.detected_outcome,
      observedAt: row.observed_at
    });
    if (!isLikelyFinishNotification(event.rawText)) {
      await sql`
        UPDATE finish_events
        SET test_run_id = '', processing_status = 'ignored', matched_confidence = 'filtered_noise', updated_at = NOW()
        WHERE event_id = ${row.event_id}
      `;
      continue;
    }
    let match = matchFinishEventToRun(event, matchRuns);
    let youtubeResolution = {
      event,
      summary: { resolved: false, reason: match.run ? "matched_local_registry" : "not_attempted" }
    };
    if (needsYouTubeResolution(match) && youtubeApiKey && youtubeLookups < 25) {
      youtubeLookups += 1;
      const resolved = await resolveFinishEventVideo(event, { youtubeApiKey });
      if (resolved.summary?.resolved || !match.run) {
        youtubeResolution = resolved;
        event = resolved.event;
        match = matchFinishEventToRun(event, matchRuns);
      }
    }
    event = alignFinishEventToMatchedRun(event, match);
    if (!match.run && isPromotableStudioFinishEvent({
      ...event,
      youtubeResolution: youtubeResolution.summary
    })) {
      const appRun = await ensureAppManagedRun({ sql, event, youtubeApiKey });
      if (appRun) {
        match = { run: appRun, matchedConfidence: "app_registry", score: 1 };
        matchRuns.push(appRun);
      }
    }
    event = alignFinishEventToMatchedRun(event, match);
    if (!match.run) continue;
    const matchedConfidence = `rematch_${resolvedMatchedConfidence(match.matchedConfidence, youtubeResolution)}`;
    await sql`
      UPDATE finish_events
      SET test_run_id = ${match.run.testRunId},
          video_id = CASE WHEN video_id = '' THEN ${event.videoId || ""} ELSE video_id END,
          channel_id = CASE WHEN channel_id = '' THEN ${event.channelId || ""} ELSE channel_id END,
          matched_confidence = ${matchedConfidence},
          processing_status = 'matched',
          payload = ${toJson({ ...event, youtubeResolution: youtubeResolution.summary })}::jsonb,
          updated_at = NOW()
      WHERE event_id = ${row.event_id}
    `;
    matched.push({
      eventId: row.event_id,
      testRunId: match.run.testRunId,
      matchedConfidence
    });
  }
  await supersedeDuplicateFinishEvents();
  await cleanupUnmatchedFinishEvents();
  return matched;
}

export async function revalidateMatchedFinishEvents({ limit = 500, youtubeApiKey = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const matchRuns = await listConnectorMatchRuns();
  const rows = await sql`
    SELECT finish_events.event_id, finish_events.video_id, finish_events.channel_id,
      finish_events.channel, finish_events.source, finish_events.raw_text,
      finish_events.notification_url, finish_events.notification_age,
      finish_events.detected_outcome, finish_events.matched_confidence,
      finish_events.payload, finish_events.occurred_at, finish_events.observed_at,
      finish_events.test_run_id, target.source_kind AS target_source_kind
    FROM finish_events
    LEFT JOIN test_runs target ON target.test_run_id = finish_events.test_run_id
    WHERE processing_status = 'matched'
      AND finish_events.source <> 'metadata'
      AND (
        (
          target.source_kind = 'app_registry'
          AND (
            finish_events.matched_confidence IN ('app_registry', 'rematch_app_registry')
            OR finish_events.video_id = ''
            OR COALESCE(finish_events.payload->>'videoTitle', '') = ''
          )
        )
        OR finish_events.matched_confidence ILIKE '%fuzzy%'
        OR COALESCE(finish_events.payload->>'videoTitle', '') = ''
        OR finish_events.raw_text ILIKE '%A/B Test completed%'
        OR (
          finish_events.video_id <> ''
          AND target.video_id <> ''
          AND finish_events.video_id <> target.video_id
        )
      )
    ORDER BY finish_events.observed_at DESC
    LIMIT ${limit}
  `;
  const changed = [];
  let youtubeLookups = 0;
  for (const row of rows) {
    const payload = fromJson(row.payload, {});
    let event = parseStudioNotification({
      ...payload,
      source: row.source,
      rawText: row.raw_text,
      url: row.notification_url,
      videoId: row.video_id,
      channelId: row.channel_id,
      channel: row.channel,
      notificationAge: notificationAgeLabel(row.notification_age || payload.notificationAge || ""),
      occurredAt: row.occurred_at || payload.occurredAt || "",
      detectedOutcome: row.detected_outcome,
      observedAt: row.observed_at
    });
    if (!isLikelyFinishNotification(event.rawText)) {
      await sql`
        UPDATE finish_events
        SET test_run_id = '', processing_status = 'ignored', matched_confidence = 'filtered_noise', updated_at = NOW()
        WHERE event_id = ${row.event_id}
      `;
      changed.push({ eventId: row.event_id, status: "ignored" });
      continue;
    }
    let match = matchFinishEventToRun(event, matchRuns);
    let youtubeResolution = {
      event,
      summary: { resolved: false, reason: match.run ? "revalidated_local_registry" : "not_attempted" }
    };
    if (needsYouTubeResolution(match) && youtubeApiKey && youtubeLookups < 25) {
      youtubeLookups += 1;
      const resolved = await resolveFinishEventVideo(event, { youtubeApiKey });
      if (resolved.summary?.resolved || !match.run) {
        youtubeResolution = resolved;
        event = resolved.event;
        match = matchFinishEventToRun(event, matchRuns);
      }
    }
    event = alignFinishEventToMatchedRun(event, match);
    if (!match.run && isPromotableStudioFinishEvent({
      ...event,
      youtubeResolution: youtubeResolution.summary
    })) {
      if (row.target_source_kind === "app_registry") {
        const appRun = await ensureAppManagedRun({ sql, event, youtubeApiKey });
        if (appRun) {
          match = { run: appRun, matchedConfidence: "app_registry", score: 1 };
          event = alignFinishEventToMatchedRun(event, match);
        }
      }
    }
    if (!match.run) {
      await sql`
        UPDATE finish_events
        SET test_run_id = '',
            video_id = ${event.videoId || ""},
            processing_status = 'unmatched',
            matched_confidence = ${match.matchedConfidence || "revalidation_unmatched"},
            payload = ${toJson({ ...event, youtubeResolution: youtubeResolution.summary })}::jsonb,
            updated_at = NOW()
        WHERE event_id = ${row.event_id}
      `;
      changed.push({ eventId: row.event_id, status: "unmatched" });
      continue;
    }
    const matchedConfidence = `revalidated_${resolvedMatchedConfidence(match.matchedConfidence, youtubeResolution)}`;
    await sql`
      UPDATE finish_events
      SET test_run_id = ${match.run.testRunId},
          video_id = ${event.videoId || match.run.videoId || ""},
          matched_confidence = ${matchedConfidence},
          processing_status = 'matched',
          payload = ${toJson({ ...event, youtubeResolution: youtubeResolution.summary })}::jsonb,
          updated_at = NOW()
      WHERE event_id = ${row.event_id}
    `;
    if (
      row.target_source_kind === "app_registry" &&
      row.test_run_id !== match.run.testRunId &&
      match.run.sourceKind !== "app_registry"
    ) {
      await reconcileManagedRunIntoTarget({
        sql,
        managedRunId: row.test_run_id,
        targetRunId: match.run.testRunId,
        confidence: "revalidated_app_registry_to_sheet"
      });
    }
    if (row.test_run_id !== match.run.testRunId || row.matched_confidence !== matchedConfidence) {
      changed.push({ eventId: row.event_id, status: "matched", testRunId: match.run.testRunId });
    }
  }
  await supersedeDuplicateFinishEvents();
  await cleanupUnmatchedFinishEvents();
  return changed;
}

export async function reconcileAppManagedRunsWithSheets() {
  await ensureSchema();
  const sql = getSql();
  const links = await sql`
    SELECT DISTINCT ON (managed.test_run_id)
      managed.test_run_id AS managed_run_id,
      sheet.test_run_id AS sheet_run_id
    FROM test_runs managed
    JOIN test_runs sheet
      ON sheet.video_id <> ''
      AND sheet.video_id = managed.video_id
      AND sheet.test_type = managed.test_type
      AND sheet.source_kind IN ('title', 'thumbnail')
      AND sheet.status <> 'source_removed'
    WHERE managed.source_kind = 'app_registry'
      AND managed.status <> 'source_removed'
    ORDER BY managed.test_run_id, sheet.start_date DESC NULLS LAST, sheet.updated_at DESC
  `;
  const reconciled = [];
  for (const link of links) {
    await reconcileManagedRunIntoTarget({
      sql,
      managedRunId: link.managed_run_id,
      targetRunId: link.sheet_run_id,
      confidence: "app_registry_to_sheet"
    });
    reconciled.push({ managedRunId: link.managed_run_id, sheetRunId: link.sheet_run_id });
  }
  return reconciled;
}

export async function reconcileLegacyYearlessDateRuns({ apply = true, rehearse = false } = {}) {
  await ensureSchema();
  const sql = getSql();
  const candidateRows = await sql`
    SELECT
      legacy.test_run_id AS legacy_run_id,
      legacy.test_id AS legacy_test_id,
      target.test_run_id AS target_run_id,
      target.test_id AS target_test_id,
      legacy.video_id,
      legacy.test_type,
      legacy.option_fingerprint,
      legacy.start_date AS legacy_start_date,
      target.start_date AS target_start_date,
      target.status AS target_status,
      target.updated_at AS target_updated_at
    FROM test_runs legacy
    JOIN test_runs target
      ON target.test_run_id <> legacy.test_run_id
      AND target.video_id <> ''
      AND target.video_id = legacy.video_id
      AND target.test_type = legacy.test_type
      AND target.option_fingerprint <> ''
      AND target.option_fingerprint = legacy.option_fingerprint
      AND target.start_date >= DATE '2020-01-01'
      AND EXTRACT(MONTH FROM target.start_date) = EXTRACT(MONTH FROM legacy.start_date)
      AND EXTRACT(DAY FROM target.start_date) = EXTRACT(DAY FROM legacy.start_date)
    WHERE legacy.start_date < DATE '2005-01-01'
      AND legacy.status <> 'source_removed'
      AND legacy.test_id IS NOT NULL
      AND target.test_id IS NOT NULL
  `;
  const unresolvedActiveRows = await sql`
    SELECT COUNT(*)::int AS total
    FROM test_runs legacy
    WHERE legacy.start_date < DATE '2005-01-01'
      AND legacy.status <> 'source_removed'
      AND NOT EXISTS (
        SELECT 1
        FROM test_runs target
        WHERE target.test_run_id <> legacy.test_run_id
          AND target.video_id <> ''
          AND target.video_id = legacy.video_id
          AND target.test_type = legacy.test_type
          AND target.option_fingerprint <> ''
          AND target.option_fingerprint = legacy.option_fingerprint
          AND target.start_date >= DATE '2020-01-01'
          AND EXTRACT(MONTH FROM target.start_date) = EXTRACT(MONTH FROM legacy.start_date)
          AND EXTRACT(DAY FROM target.start_date) = EXTRACT(DAY FROM legacy.start_date)
      )
  `;
  const planned = planLegacyYearlessDateReconciliation(candidateRows.map((row) => ({
    legacyRunId: row.legacy_run_id,
    legacyTestId: row.legacy_test_id,
    targetRunId: row.target_run_id,
    targetTestId: row.target_test_id,
    videoId: row.video_id,
    testType: row.test_type,
    optionFingerprint: row.option_fingerprint,
    legacyStartDate: formatDateOnly(row.legacy_start_date),
    targetStartDate: formatDateOnly(row.target_start_date),
    targetStatus: row.target_status,
    targetUpdatedAt: row.target_updated_at
  })));
  const plan = {
    ...planned,
    unresolvedActive: Number(unresolvedActiveRows[0]?.total || 0)
  };
  if (!apply || !plan.mappings.length) return plan;

  const mappings = JSON.stringify(plan.mappings.map((item) => ({
    legacy_run_id: item.legacyRunId,
    legacy_test_id: item.legacyTestId,
    target_run_id: item.targetRunId,
    target_test_id: item.targetTestId
  })));
  try {
    await sql.transaction((txn) => [
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE logical_tests target
      SET result = CASE
            WHEN target.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN target.result
            WHEN legacy.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN legacy.result
            ELSE target.result
          END,
          result_evidence = CASE
            WHEN target.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN target.result_evidence
            WHEN legacy.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN legacy.result_evidence
            ELSE target.result_evidence
          END,
          result_semantics_version = COALESCE(NULLIF(target.result_semantics_version, ''), legacy.result_semantics_version),
          explicit_winner_variant = COALESCE(NULLIF(target.explicit_winner_variant, ''), legacy.explicit_winner_variant),
          operational_decision = COALESCE(NULLIF(target.operational_decision, ''), legacy.operational_decision),
          inconclusive_reason = COALESCE(NULLIF(target.inconclusive_reason, ''), legacy.inconclusive_reason),
          inconclusive_reason_evidence = COALESCE(NULLIF(target.inconclusive_reason_evidence, ''), legacy.inconclusive_reason_evidence),
          updated_at = NOW()
      FROM mapping
      JOIN logical_tests legacy ON legacy.test_id = mapping.legacy_test_id
      WHERE target.test_id = mapping.target_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE finish_events event
      SET test_run_id = mapping.target_run_id,
          test_id = mapping.target_test_id,
          matched_confidence = CASE
            WHEN event.matched_confidence = '' THEN 'legacy_yearless_date_reconciled'
            ELSE event.matched_confidence
          END,
          updated_at = NOW()
      FROM mapping
      WHERE event.test_run_id = mapping.legacy_run_id
         OR event.test_id = mapping.legacy_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_actions action
      SET test_run_id = mapping.target_run_id,
          test_id = mapping.target_test_id,
          metadata = COALESCE(action.metadata, '{}'::jsonb) ||
            jsonb_build_object('reconciledFrom', mapping.legacy_run_id, 'reason', 'legacy_yearless_date')
      FROM mapping
      WHERE action.test_run_id = mapping.legacy_run_id
         OR action.test_id = mapping.legacy_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      INSERT INTO review_resolutions (
        resolution_id, target_type, target_id, action, actor_name, note, metadata, created_at
      )
      SELECT
        'rr_' || md5(resolution.resolution_id || mapping.target_run_id),
        'test_run', mapping.target_run_id, resolution.action, resolution.actor_name,
        resolution.note,
        COALESCE(resolution.metadata, '{}'::jsonb) ||
          jsonb_build_object('reconciledFrom', mapping.legacy_run_id, 'reason', 'legacy_yearless_date'),
        resolution.created_at
      FROM review_resolutions resolution
      JOIN mapping ON resolution.target_type = 'test_run'
        AND resolution.target_id = mapping.legacy_run_id
      WHERE resolution.undone_at IS NULL
      ON CONFLICT (target_type, target_id, action) DO NOTHING
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_identity_aliases alias
      SET test_id = mapping.target_test_id,
          last_seen_at = NOW()
      FROM mapping
      WHERE alias.test_id = mapping.legacy_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_source_links link
      SET test_id = mapping.target_test_id,
          linkage_method = 'legacy_yearless_date_reconciled',
          linkage_confidence = 'deterministic',
          updated_at = NOW()
      FROM mapping
      WHERE link.test_id = mapping.legacy_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_id_history history
      SET test_id = mapping.target_test_id,
          reason = history.reason || '; reconciled legacy yearless date identity'
      FROM mapping
      WHERE history.test_id = mapping.legacy_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_runs run
      SET test_id = mapping.target_test_id,
          status = 'source_removed',
          drift_reason = 'legacy_yearless_date_reconciled:' || mapping.target_run_id,
          updated_at = NOW()
      FROM mapping
      WHERE run.test_run_id = mapping.legacy_run_id
    `,
    txn`
      WITH mapping AS (
        SELECT DISTINCT legacy_test_id, target_test_id
        FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      UPDATE test_runs run
      SET test_id = mapping.target_test_id,
          updated_at = NOW()
      FROM mapping
      WHERE run.test_id = mapping.legacy_test_id
        AND mapping.legacy_test_id <> mapping.target_test_id
    `,
    txn`
      WITH mapping AS (
        SELECT DISTINCT legacy_test_id, target_test_id
        FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
          legacy_run_id text, legacy_test_id text, target_run_id text, target_test_id text
        )
      )
      DELETE FROM logical_tests legacy
      USING mapping
      WHERE legacy.test_id = mapping.legacy_test_id
        AND legacy.test_id <> mapping.target_test_id
        AND NOT EXISTS (SELECT 1 FROM test_runs run WHERE run.test_id = legacy.test_id)
        AND NOT EXISTS (SELECT 1 FROM test_actions action WHERE action.test_id = legacy.test_id)
        AND NOT EXISTS (SELECT 1 FROM finish_events event WHERE event.test_id = legacy.test_id)
    `,
    ...(rehearse
      ? [txn`SELECT CAST(${'legacy_date_rehearsal_rollback'} AS integer)`]
      : [])
    ]);
  } catch (error) {
    if (rehearse && error?.code === "22P02") {
      return { ...plan, rehearsed: true };
    }
    throw error;
  }
  return { ...plan, rehearsed: false };
}

export async function reconcileExactMaterialIdentitySplits({ apply = true, rehearse = false } = {}) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    WITH split_keys AS (
      SELECT video_id, test_type, start_date, option_fingerprint
      FROM test_runs
      WHERE test_id IS NOT NULL
        AND video_id <> ''
        AND start_date >= DATE '2020-01-01'
        AND option_fingerprint <> ''
      GROUP BY video_id, test_type, start_date, option_fingerprint
      HAVING COUNT(DISTINCT test_id) > 1
    )
    SELECT DISTINCT ON (
      tr.video_id, tr.test_type, tr.start_date, tr.option_fingerprint, tr.test_id
    )
      tr.test_id,
      tr.video_id,
      tr.test_type,
      tr.start_date,
      tr.option_fingerprint,
      tr.status,
      tr.updated_at,
      lt.result,
      lt.result_evidence,
      lt.explicit_winner_variant,
      COALESCE((
        SELECT jsonb_agg(DISTINCT action.action)
        FROM test_actions action
        WHERE action.undone_at IS NULL
          AND (
            action.test_id = tr.test_id
            OR action.test_run_id IN (
              SELECT sibling.test_run_id FROM test_runs sibling WHERE sibling.test_id = tr.test_id
            )
          )
      ), '[]'::jsonb) AS active_actions
    FROM test_runs tr
    JOIN split_keys split
      ON split.video_id = tr.video_id
      AND split.test_type = tr.test_type
      AND split.start_date = tr.start_date
      AND split.option_fingerprint = tr.option_fingerprint
    LEFT JOIN logical_tests lt ON lt.test_id = tr.test_id
    ORDER BY
      tr.video_id,
      tr.test_type,
      tr.start_date,
      tr.option_fingerprint,
      tr.test_id,
      CASE WHEN tr.status = 'source_removed' THEN 1 ELSE 0 END,
      tr.updated_at DESC
  `;
  const plan = planExactMaterialReconciliation(rows.map((row) => ({
    testId: row.test_id,
    videoId: row.video_id,
    testType: row.test_type,
    startDate: formatDateOnly(row.start_date),
    optionFingerprint: row.option_fingerprint,
    status: row.status,
    result: row.result || "unknown",
    resultEvidence: row.result_evidence || "unknown",
    explicitWinnerVariant: row.explicit_winner_variant || "",
    activeActions: fromJson(row.active_actions, []),
    updatedAt: row.updated_at
  })));
  if (!apply || !plan.mappings.length) return plan;

  const mappings = JSON.stringify(plan.mappings.map((item) => ({
    source_test_id: item.sourceTestId,
    target_test_id: item.targetTestId
  })));
  try {
    await sql.transaction((txn) => [
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE logical_tests target
        SET result = CASE
              WHEN target.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN target.result
              WHEN source.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN source.result
              ELSE target.result
            END,
            result_evidence = CASE
              WHEN target.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN target.result_evidence
              WHEN source.result_evidence IN ('studio_explicit', 'sheet_explicit') THEN source.result_evidence
              ELSE target.result_evidence
            END,
            result_semantics_version = COALESCE(NULLIF(target.result_semantics_version, ''), source.result_semantics_version),
            explicit_winner_variant = COALESCE(NULLIF(target.explicit_winner_variant, ''), source.explicit_winner_variant),
            operational_decision = COALESCE(NULLIF(target.operational_decision, ''), source.operational_decision),
            inconclusive_reason = COALESCE(NULLIF(target.inconclusive_reason, ''), source.inconclusive_reason),
            inconclusive_reason_evidence = COALESCE(NULLIF(target.inconclusive_reason_evidence, ''), source.inconclusive_reason_evidence),
            updated_at = NOW()
        FROM mapping
        JOIN logical_tests source ON source.test_id = mapping.source_test_id
        WHERE target.test_id = mapping.target_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE finish_events event
        SET test_id = mapping.target_test_id,
            updated_at = NOW()
        FROM mapping
        WHERE event.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE test_actions action
        SET test_id = mapping.target_test_id,
            metadata = COALESCE(action.metadata, '{}'::jsonb) ||
              jsonb_build_object('reconciledTestIdFrom', mapping.source_test_id, 'reason', 'exact_material_identity')
        FROM mapping
        WHERE action.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE test_identity_aliases alias
        SET test_id = mapping.target_test_id,
            last_seen_at = NOW()
        FROM mapping
        WHERE alias.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE test_source_links link
        SET test_id = mapping.target_test_id,
            linkage_method = 'exact_material_reconciled',
            linkage_confidence = 'deterministic',
            updated_at = NOW()
        FROM mapping
        WHERE link.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE test_id_history history
        SET test_id = mapping.target_test_id,
            reason = history.reason || '; reconciled exact material identity'
        FROM mapping
        WHERE history.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        UPDATE test_runs run
        SET test_id = mapping.target_test_id,
            updated_at = NOW()
        FROM mapping
        WHERE run.test_id = mapping.source_test_id
      `,
      txn`
        WITH mapping AS (
          SELECT * FROM jsonb_to_recordset(${mappings}::jsonb) AS item(
            source_test_id text, target_test_id text
          )
        )
        DELETE FROM logical_tests source
        USING mapping
        WHERE source.test_id = mapping.source_test_id
          AND NOT EXISTS (SELECT 1 FROM test_runs run WHERE run.test_id = source.test_id)
          AND NOT EXISTS (SELECT 1 FROM test_actions action WHERE action.test_id = source.test_id)
          AND NOT EXISTS (SELECT 1 FROM finish_events event WHERE event.test_id = source.test_id)
      `,
      ...(rehearse
        ? [txn`SELECT CAST(${'exact_material_rehearsal_rollback'} AS integer)`]
        : [])
    ]);
  } catch (error) {
    if (rehearse && error?.code === "22P02") return { ...plan, rehearsed: true };
    throw error;
  }
  return { ...plan, rehearsed: false };
}

export async function auditDataIntegrity() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM test_runs run
        WHERE run.status <> 'source_removed'
          AND run.finish_date IS NOT NULL
          AND run.start_date IS NOT NULL
          AND run.finish_date < run.start_date
      ) AS finish_before_start,
      (
        SELECT COUNT(*)::int
        FROM test_runs run
        WHERE run.result NOT IN ('winner', 'performed_same', 'inconclusive', 'cancelled', 'running', 'unknown')
      ) AS invalid_run_results,
      (
        SELECT COUNT(*)::int
        FROM logical_tests test
        WHERE test.result NOT IN ('winner', 'performed_same', 'inconclusive', 'cancelled', 'running', 'unknown')
      ) AS invalid_logical_results,
      (
        SELECT COUNT(*)::int
        FROM test_actions action
        JOIN test_runs run ON run.test_run_id = action.test_run_id
        WHERE action.test_id IS NOT NULL
          AND run.test_id IS NOT NULL
          AND action.test_id <> run.test_id
      ) AS action_identity_mismatches,
      (
        SELECT COUNT(*)::int
        FROM finish_events event
        JOIN test_runs run ON run.test_run_id = event.test_run_id
        WHERE event.test_id IS NOT NULL
          AND run.test_id IS NOT NULL
          AND event.test_id <> run.test_id
      ) AS event_identity_mismatches,
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT video_id, test_type, start_date, option_fingerprint
          FROM test_runs
          WHERE test_id IS NOT NULL
            AND video_id <> ''
            AND start_date >= DATE '2020-01-01'
            AND option_fingerprint <> ''
          GROUP BY video_id, test_type, start_date, option_fingerprint
          HAVING COUNT(DISTINCT test_id) > 1
        ) split
      ) AS exact_material_splits
      ,(
        WITH desired_raw AS (
          SELECT DISTINCT
            run.test_id,
            'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
          FROM test_runs run
          WHERE run.test_id IS NOT NULL
            AND run.status <> 'source_removed'
            AND run.video_id <> ''
            AND run.test_type <> ''
            AND run.start_date IS NOT NULL
        ), desired AS (
          SELECT alias_value, MIN(test_id) AS test_id, COUNT(DISTINCT test_id)::int AS owners
          FROM desired_raw
          GROUP BY alias_value
        )
        SELECT COUNT(*)::int
        FROM test_identity_aliases alias
        LEFT JOIN desired ON desired.alias_value = alias.alias_value
        WHERE alias.active
          AND alias.alias_type = 'video-date'
          AND (
            desired.alias_value IS NULL
            OR desired.owners <> 1
            OR desired.test_id <> alias.test_id
          )
          AND EXISTS (
            SELECT 1 FROM test_runs active_run
            WHERE active_run.test_id = alias.test_id
              AND active_run.status <> 'source_removed'
          )
      ) AS date_alias_issues
  `;
  const row = rows[0] || {};
  return {
    finishBeforeStart: Number(row.finish_before_start || 0),
    invalidRunResults: Number(row.invalid_run_results || 0),
    invalidLogicalResults: Number(row.invalid_logical_results || 0),
    actionIdentityMismatches: Number(row.action_identity_mismatches || 0),
    eventIdentityMismatches: Number(row.event_identity_mismatches || 0),
    exactMaterialSplits: Number(row.exact_material_splits || 0),
    dateAliasIssues: Number(row.date_alias_issues || 0)
  };
}

export async function repairDateIdentityAliases({ apply = true, rehearse = false } = {}) {
  await ensureSchema();
  const sql = getSql();
  const summaryRows = await sql`
    WITH desired_raw AS (
      SELECT DISTINCT
        run.test_id,
        'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
      FROM test_runs run
      WHERE run.test_id IS NOT NULL
        AND run.status <> 'source_removed'
        AND run.video_id <> ''
        AND run.test_type <> ''
        AND run.start_date IS NOT NULL
    ), desired AS (
      SELECT alias_value, MIN(test_id) AS test_id, COUNT(DISTINCT test_id)::int AS owners
      FROM desired_raw
      GROUP BY alias_value
    )
    SELECT
      COUNT(*) FILTER (WHERE desired.owners = 1 AND alias.alias_id IS NULL)::int AS missing,
      COUNT(*) FILTER (WHERE desired.owners = 1 AND alias.alias_id IS NOT NULL AND alias.test_id <> desired.test_id)::int AS wrong_owner,
      COUNT(*) FILTER (WHERE desired.owners > 1)::int AS ambiguous,
      (
        SELECT COUNT(*)::int
        FROM test_identity_aliases existing
        WHERE existing.active
          AND existing.alias_type = 'video-date'
          AND EXISTS (
            SELECT 1 FROM test_runs active_run
            WHERE active_run.test_id = existing.test_id
              AND active_run.status <> 'source_removed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM desired_raw wanted
            WHERE wanted.test_id = existing.test_id
              AND wanted.alias_value = existing.alias_value
          )
      ) AS stale
    FROM desired
    LEFT JOIN test_identity_aliases alias ON alias.alias_value = desired.alias_value
  `;
  const summary = {
    missing: Number(summaryRows[0]?.missing || 0),
    wrongOwner: Number(summaryRows[0]?.wrong_owner || 0),
    ambiguous: Number(summaryRows[0]?.ambiguous || 0),
    stale: Number(summaryRows[0]?.stale || 0)
  };
  if (!apply || !Object.values(summary).some(Boolean)) return summary;

  try {
    await sql.transaction((txn) => [
      txn`
        WITH desired_raw AS (
          SELECT DISTINCT
            run.test_id,
            'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
          FROM test_runs run
          WHERE run.test_id IS NOT NULL
            AND run.status <> 'source_removed'
            AND run.video_id <> ''
            AND run.test_type <> ''
            AND run.start_date IS NOT NULL
        )
        UPDATE test_identity_aliases alias
        SET active = FALSE,
            last_seen_at = NOW()
        WHERE alias.alias_type = 'video-date'
          AND alias.active
          AND EXISTS (
            SELECT 1 FROM test_runs active_run
            WHERE active_run.test_id = alias.test_id
              AND active_run.status <> 'source_removed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM desired_raw desired
            WHERE desired.test_id = alias.test_id
              AND desired.alias_value = alias.alias_value
          )
      `,
      txn`
        WITH desired_raw AS (
          SELECT DISTINCT
            run.test_id,
            'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
          FROM test_runs run
          WHERE run.test_id IS NOT NULL
            AND run.status <> 'source_removed'
            AND run.video_id <> ''
            AND run.test_type <> ''
            AND run.start_date IS NOT NULL
        ), desired AS (
          SELECT alias_value, MIN(test_id) AS test_id, COUNT(DISTINCT test_id)::int AS owners
          FROM desired_raw
          GROUP BY alias_value
        )
        UPDATE test_identity_aliases alias
        SET test_id = desired.test_id,
            active = TRUE,
            last_seen_at = NOW()
        FROM desired
        WHERE desired.owners = 1
          AND alias.alias_value = desired.alias_value
      `,
      txn`
        WITH desired_raw AS (
          SELECT DISTINCT
            run.test_id,
            'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
          FROM test_runs run
          WHERE run.test_id IS NOT NULL
            AND run.status <> 'source_removed'
            AND run.video_id <> ''
            AND run.test_type <> ''
            AND run.start_date IS NOT NULL
        ), desired AS (
          SELECT alias_value, MIN(test_id) AS test_id, COUNT(DISTINCT test_id)::int AS owners
          FROM desired_raw
          GROUP BY alias_value
        )
        INSERT INTO test_identity_aliases (
          alias_id, test_id, alias_type, alias_value, first_seen_at, last_seen_at, active
        )
        SELECT
          'alias_' || md5(desired.alias_value),
          desired.test_id,
          'video-date',
          desired.alias_value,
          NOW(),
          NOW(),
          TRUE
        FROM desired
        WHERE desired.owners = 1
        ON CONFLICT (alias_value) DO NOTHING
      `,
      txn`
        WITH desired_raw AS (
          SELECT DISTINCT
            run.test_id,
            'video-date:' || run.video_id || ':' || run.test_type || ':' || TO_CHAR(run.start_date, 'YYYY-MM-DD') AS alias_value
          FROM test_runs run
          WHERE run.test_id IS NOT NULL
            AND run.status <> 'source_removed'
            AND run.video_id <> ''
            AND run.test_type <> ''
            AND run.start_date IS NOT NULL
        ), ambiguous AS (
          SELECT alias_value
          FROM desired_raw
          GROUP BY alias_value
          HAVING COUNT(DISTINCT test_id) > 1
        )
        UPDATE test_identity_aliases alias
        SET active = FALSE,
            last_seen_at = NOW()
        FROM ambiguous
        WHERE alias.alias_value = ambiguous.alias_value
      `,
      ...(rehearse
        ? [txn`SELECT CAST(${'date_alias_rehearsal_rollback'} AS integer)`]
        : [])
    ]);
  } catch (error) {
    if (rehearse && error?.code === "22P02") return { ...summary, rehearsed: true };
    throw error;
  }
  return { ...summary, rehearsed: false };
}

async function reconcileManagedRunIntoTarget({
  sql,
  managedRunId,
  targetRunId,
  confidence = "app_registry_to_sheet"
}) {
  if (!managedRunId || !targetRunId || managedRunId === targetRunId) return;
  await sql`
    UPDATE finish_events
    SET test_run_id = ${targetRunId},
        matched_confidence = ${confidence},
        processing_status = 'matched',
        updated_at = NOW()
    WHERE test_run_id = ${managedRunId}
  `;
  await sql`
    UPDATE test_actions
    SET test_run_id = ${targetRunId},
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('reconciledFrom', ${managedRunId}::text)
    WHERE test_run_id = ${managedRunId}
  `;
  await sql`
    INSERT INTO review_resolutions (
      resolution_id, target_type, target_id, action, actor_name, note, metadata, created_at
    )
    SELECT
      'rr_' || md5(resolution_id || ${targetRunId}),
      'test_run',
      ${targetRunId},
      action,
      actor_name,
      note,
      COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('reconciledFrom', ${managedRunId}::text),
      created_at
    FROM review_resolutions
    WHERE target_type = 'test_run'
      AND target_id = ${managedRunId}
      AND undone_at IS NULL
    ON CONFLICT (target_type, target_id, action) DO NOTHING
  `;
  await sql`
    UPDATE test_runs
    SET status = 'source_removed',
        drift_reason = 'reconciled_to_sheet',
        updated_at = NOW()
    WHERE test_run_id = ${managedRunId}
  `;
}

export async function consolidateDuplicateAppManagedRuns() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      tr.test_run_id,
      tr.video_id,
      tr.source_kind,
      tr.status,
      tr.test_type,
      tr.channel,
      tr.video_title,
      tr.current_youtube_title,
      tr.current_youtube_thumbnail_url,
      tr.youtube_channel_id,
      tr.youtube_channel_title,
      tr.updated_at,
      (
        SELECT COUNT(*)
        FROM test_actions ta
        WHERE ta.test_run_id = tr.test_run_id
          AND ta.undone_at IS NULL
      )::int AS active_action_count,
      (
        SELECT COUNT(*)
        FROM finish_events fe
        WHERE fe.test_run_id = tr.test_run_id
          AND fe.processing_status = 'matched'
      )::int AS matched_event_count
    FROM test_runs tr
    WHERE tr.source_kind = 'app_registry'
      AND tr.status <> 'source_removed'
  `;
  const plans = planAppManagedConsolidation(rows.map((row) => ({
    testRunId: row.test_run_id,
    videoId: row.video_id,
    sourceKind: row.source_kind,
    status: row.status,
    testType: row.test_type,
    channel: row.channel,
    videoTitle: row.video_title,
    currentYoutubeTitle: row.current_youtube_title,
    currentYoutubeThumbnailUrl: row.current_youtube_thumbnail_url,
    youtubeChannelId: row.youtube_channel_id,
    youtubeChannelTitle: row.youtube_channel_title,
    updatedAt: row.updated_at,
    activeActionCount: row.active_action_count,
    matchedEventCount: row.matched_event_count
  })));

  for (const plan of plans) {
    await sql.query(
      `
        UPDATE finish_events
        SET test_run_id = $1,
            matched_confidence = CASE
              WHEN matched_confidence = '' THEN 'app_registry_consolidated'
              ELSE matched_confidence
            END,
            updated_at = NOW()
        WHERE test_run_id = ANY($2::text[])
      `,
      [plan.canonicalId, plan.duplicateIds]
    );
    await sql.query(
      `
        UPDATE test_actions
        SET test_run_id = $1,
            metadata = COALESCE(metadata, '{}'::jsonb) ||
              jsonb_build_object('consolidatedFrom', test_run_id)
        WHERE test_run_id = ANY($2::text[])
      `,
      [plan.canonicalId, plan.duplicateIds]
    );
    await sql.query(
      `
        INSERT INTO review_resolutions (
          resolution_id, target_type, target_id, action, actor_name, note, metadata, created_at
        )
        SELECT
          'rr_' || md5(resolution_id || $1),
          target_type,
          $1,
          action,
          actor_name,
          note,
          COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('consolidatedFrom', target_id),
          created_at
        FROM review_resolutions
        WHERE target_type = 'test_run'
          AND target_id = ANY($2::text[])
          AND undone_at IS NULL
        ON CONFLICT (target_type, target_id, action) DO NOTHING
      `,
      [plan.canonicalId, plan.duplicateIds]
    );
    await sql.query(
      `
        UPDATE test_runs
        SET status = 'source_removed',
            drift_reason = 'duplicate_app_registry:' || $1,
            updated_at = NOW()
        WHERE test_run_id = ANY($2::text[])
      `,
      [plan.canonicalId, plan.duplicateIds]
    );
  }
  if (plans.length) await supersedeDuplicateFinishEvents();
  return plans;
}

export async function quarantineWeakAppManagedRuns() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT
      tr.test_run_id,
      EXISTS (
        SELECT 1
        FROM test_actions ta
        WHERE ta.test_run_id = tr.test_run_id
          AND ta.undone_at IS NULL
      ) AS has_action,
      COALESCE((
        SELECT json_agg(row_to_json(fe) ORDER BY fe.observed_at DESC)
        FROM finish_events fe
        WHERE fe.test_run_id = tr.test_run_id
          AND fe.processing_status = 'matched'
          AND fe.source <> 'metadata'
      ), '[]'::json) AS finish_events
    FROM test_runs tr
    WHERE tr.source_kind = 'app_registry'
      AND tr.status <> 'source_removed'
  `;

  const weakEventIds = [];
  const retiredRunIds = [];
  for (const row of rows) {
    const events = fromJson(row.finish_events, []);
    const validEvents = events.filter((event) => {
      const payload = fromJson(event.payload, {});
      return isPromotableStudioFinishEvent({
        ...payload,
        rawText: event.raw_text,
        videoId: event.video_id,
        channelId: event.channel_id,
        channel: event.channel,
        payload
      });
    });
    for (const event of events) {
      if (!validEvents.some((candidate) => candidate.event_id === event.event_id)) {
        weakEventIds.push(event.event_id);
      }
    }
    if (!validEvents.length && !row.has_action) retiredRunIds.push(row.test_run_id);
  }

  if (weakEventIds.length) {
    await sql.query(
      `
        UPDATE finish_events
        SET test_run_id = '',
            processing_status = 'ignored',
            matched_confidence = 'filtered_incomplete_signal',
            updated_at = NOW()
        WHERE event_id = ANY($1::text[])
      `,
      [weakEventIds]
    );
  }
  if (retiredRunIds.length) {
    await sql.query(
      `
        UPDATE test_runs
        SET status = 'source_removed',
            drift_reason = 'incomplete_studio_signal',
            updated_at = NOW()
        WHERE test_run_id = ANY($1::text[])
      `,
      [retiredRunIds]
    );
  }
  return {
    ignoredEvents: weakEventIds.length,
    retiredRuns: retiredRunIds.length
  };
}

function needsYouTubeResolution(match) {
  return !match?.run || String(match.matchedConfidence || "").includes("fuzzy");
}

async function supersedeDuplicateFinishEvents() {
  const sql = getSql();
  await sql`
    WITH ranked AS (
      SELECT event_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            CASE
              WHEN test_id IS NOT NULL THEN test_id
              ELSE COALESCE(
                NULLIF(video_id, ''),
                NULLIF(LOWER(payload->>'videoTitle'), ''),
                LOWER(REGEXP_REPLACE(raw_text, '\s+', ' ', 'g'))
              )
            END,
            COALESCE(NULLIF(channel_id, ''), LOWER(channel)),
            CASE WHEN result <> 'unknown' THEN result ELSE detected_outcome END,
            CASE WHEN test_id IS NULL THEN DATE_TRUNC('day', COALESCE(occurred_at, observed_at)) END,
            CASE WHEN test_id IS NULL THEN LOWER(REGEXP_REPLACE(raw_text, '\s+', ' ', 'g')) ELSE '' END
          ORDER BY
            CASE
              WHEN raw_text ~* '(we updated your video to use the winner|results? with very similar performance|not enough (views|impressions)( to (determine|declare) a winner)?|(the )?test completed with no winner)[.!]?$'
                THEN 0
              WHEN raw_text ~* 'we updated your video|results? with very similar performance|not enough (views|impressions)|completed with no winner'
                THEN 1
              ELSE 2
            END,
            CASE WHEN notification_age <> '' THEN 0 ELSE 1 END,
            LENGTH(raw_text) DESC,
            observed_at DESC
        ) AS duplicate_rank
      FROM finish_events
      WHERE processing_status = 'matched'
        AND source <> 'metadata'
    )
    UPDATE finish_events fe
    SET processing_status = 'superseded', updated_at = NOW()
    FROM ranked
    WHERE fe.event_id = ranked.event_id
      AND ranked.duplicate_rank > 1
  `;
  await sql`
    UPDATE finish_events generic
    SET processing_status = 'superseded',
        matched_confidence = CASE
          WHEN matched_confidence = '' THEN 'superseded_by_explicit_result'
          ELSE matched_confidence
        END,
        updated_at = NOW()
    WHERE generic.processing_status = 'matched'
      AND generic.source <> 'metadata'
      AND generic.detected_outcome = 'finished_unknown'
      AND EXISTS (
        SELECT 1
        FROM finish_events explicit
        WHERE explicit.test_run_id = generic.test_run_id
          AND explicit.event_id <> generic.event_id
          AND explicit.processing_status = 'matched'
          AND explicit.source <> 'metadata'
          AND explicit.result_evidence = 'studio_explicit'
          AND explicit.result IN ('winner', 'performed_same', 'inconclusive')
      )
  `;
}

async function cleanupUnmatchedFinishEvents() {
  const sql = getSql();
  const rows = await sql`
    SELECT event_id, video_id, channel_id, channel, source, raw_text, notification_url,
      notification_age, detected_outcome, actor_name, payload, occurred_at, observed_at, created_at
    FROM finish_events
    WHERE processing_status = 'unmatched'
    ORDER BY observed_at DESC
    LIMIT 1000
  `;
  const events = rows.map((row) => {
    const payload = fromJson(row.payload, {});
    return {
      eventId: row.event_id,
      videoId: row.video_id,
      channelId: row.channel_id,
      channel: row.channel,
      source: row.source,
      rawText: row.raw_text,
      notificationUrl: row.notification_url,
      notificationAge: notificationAgeLabel(row.notification_age || payload.notificationAge || ""),
      detectedOutcome: row.detected_outcome,
      videoTitle: payload.videoTitle || "",
      occurredAt: row.occurred_at || payload.occurredAt || "",
      observedAt: row.observed_at,
      createdAt: row.created_at
    };
  });
  const consolidated = consolidateUnmatchedFinishEvents(events);
  if (consolidated.duplicateIds.length) {
    await sql.query(
      "UPDATE finish_events SET processing_status = 'superseded', matched_confidence = 'duplicate_unmatched', updated_at = NOW() WHERE event_id = ANY($1::text[])",
      [consolidated.duplicateIds]
    );
  }
  if (consolidated.rejectedIds.length) {
    await sql.query(
      "UPDATE finish_events SET processing_status = 'ignored', matched_confidence = 'filtered_noise', updated_at = NOW() WHERE event_id = ANY($1::text[])",
      [consolidated.rejectedIds]
    );
  }
  return {
    kept: consolidated.events.length,
    superseded: consolidated.duplicateIds.length,
    ignored: consolidated.rejectedIds.length
  };
}

export async function recordConnectorHeartbeat({ connectorId, actorName, channels, version, status, payload }) {
  await ensureSchema();
  const sql = getSql();
  const id = connectorId || crypto.randomUUID();
  await sql`
    INSERT INTO connector_heartbeats (
      connector_id,
      actor_name,
      channels,
      version,
      status,
      payload,
      last_seen_at
    )
    VALUES (
      ${id},
      ${actorName || ""},
      ${toJson(channels || [])}::jsonb,
      ${version || ""},
      ${status || "online"},
      ${toJson(payload || {})}::jsonb,
      NOW()
    )
    ON CONFLICT (connector_id)
    DO UPDATE SET
      actor_name = EXCLUDED.actor_name,
      channels = EXCLUDED.channels,
      version = EXCLUDED.version,
      status = EXCLUDED.status,
      payload = EXCLUDED.payload,
      last_seen_at = NOW()
  `;
  return getConnectorStatus();
}

export async function getConnectorStatus() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT connector_id, actor_name, channels, version, status, payload, last_seen_at
    FROM connector_heartbeats
    ORDER BY last_seen_at DESC
    LIMIT 300
  `;
  return rows.map((row) => ({
    connectorId: row.connector_id,
    actorName: row.actor_name,
    channels: fromJson(row.channels, []),
    version: row.version,
    status: row.status,
    payload: fromJson(row.payload, {}),
    lastSeenAt: row.last_seen_at,
    active: isRecent(row.last_seen_at)
  }));
}

export async function listUnmatchedFinishEvents() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
      SELECT
        fe.event_id,
        fe.video_id,
        fe.channel_id,
        fe.channel,
      fe.source,
      fe.raw_text,
        fe.notification_url,
        fe.notification_age,
      fe.detected_outcome,
      fe.actor_name,
        fe.payload,
        fe.occurred_at,
        fe.observed_at,
      fe.created_at
    FROM finish_events fe
    LEFT JOIN review_resolutions rr
      ON rr.target_type = 'finish_event'
      AND rr.target_id = fe.event_id
      AND rr.action IN ('ignore', 'A', 'B', 'C', 'NO_CLEAR', 'KEPT_CURRENT', 'RETEST_LATER', 'SKIP')
      AND rr.undone_at IS NULL
    WHERE fe.processing_status = 'unmatched'
      AND rr.resolution_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM finish_events fe2
        JOIN review_resolutions rr2
          ON rr2.target_type = 'finish_event'
          AND rr2.target_id = fe2.event_id
          AND rr2.action IN ('ignore', 'match', 'A', 'B', 'C', 'NO_CLEAR', 'KEPT_CURRENT', 'RETEST_LATER', 'SKIP')
          AND rr2.undone_at IS NULL
        WHERE fe2.event_id <> fe.event_id
          AND LOWER(TRIM(fe2.raw_text)) = LOWER(TRIM(fe.raw_text))
          AND COALESCE(fe2.video_id, '') = COALESCE(fe.video_id, '')
          AND LOWER(TRIM(fe2.channel)) = LOWER(TRIM(fe.channel))
      )
      AND (
        fe.raw_text ILIKE '%test & compare%'
        OR fe.raw_text ILIKE '%test and compare%'
        OR fe.raw_text ILIKE '%a/b%'
        OR fe.raw_text ILIKE '%ab test%'
        OR fe.raw_text ILIKE '%thumbnail test%'
        OR fe.raw_text ILIKE '%title test%'
        OR fe.raw_text ILIKE '%not enough views%'
        OR fe.raw_text ILIKE '%not enough impressions%'
        OR fe.raw_text ILIKE '%no clear%'
      )
      AND fe.raw_text NOT ILIKE '%set a thumbnail that stands out%'
      AND fe.raw_text NOT ILIKE '%made for kids%'
      AND fe.raw_text NOT ILIKE '%coppa%'
      AND fe.raw_text NOT ILIKE '%personalized ads and notifications%'
      AND fe.raw_text NOT ILIKE '%a/b test running%'
      AND fe.raw_text NOT ILIKE '%ab test running%'
      AND fe.raw_text NOT ILIKE '%test running%'
      AND fe.raw_text NOT ILIKE '%running… get suggestions%'
      AND LOWER(TRIM(fe.raw_text)) NOT IN (
        'a/b test completed',
        'ab test completed',
        'thumbnail test ready',
        'thumbnail test ready set test',
        'title test ready',
        'title test ready set test'
      )
    ORDER BY fe.observed_at DESC
    LIMIT 50
  `;
    return rows.map((row) => {
      const payload = fromJson(row.payload, {});
      return {
        eventId: row.event_id,
        videoId: row.video_id,
        channelId: row.channel_id,
        channel: row.channel,
        videoTitle: payload.videoTitle || "",
        source: row.source,
        rawText: row.raw_text,
        notificationUrl: row.notification_url,
        notificationAge: notificationAgeLabel(row.notification_age || payload.notificationAge || ""),
        detectedOutcome: row.detected_outcome,
        youtubeCandidates: payload.youtubeCandidates || payload.youtubeResolution?.candidates || [],
        actorName: row.actor_name,
        occurredAt: row.occurred_at || payload.occurredAt || "",
        observedAt: row.observed_at,
        createdAt: row.created_at
      };
    });
}

async function resolveFinishEventVideo(event, { youtubeApiKey = "" } = {}) {
  if (!event.videoTitle || !youtubeApiKey) {
    return { event, summary: { source: "none", candidates: [] } };
  }
  try {
    let searchEvent = event;
    let rejectedVideoContext = null;
    if (event.videoId) {
      const found = await fetchYouTubeVideoMetadata([event.videoId], youtubeApiKey);
      const metadata = found[event.videoId] || {};
      if (metadata.title && notificationTitleMatchesVideoMetadata(event, metadata)) {
        return {
          event: {
            ...event,
            channelId: event.channelId || metadata.channelId || "",
            channel: event.channel || metadata.channelTitle || ""
          },
          summary: {
            source: "youtube_metadata",
            resolved: true,
            videoId: event.videoId,
            title: metadata.title,
            channel: metadata.channelTitle || "",
            channelId: metadata.channelId || "",
            score: 1,
            candidates: []
          }
        };
      }
      if (metadata.title) {
        rejectedVideoContext = {
          videoId: event.videoId,
          title: metadata.title,
          reason: "notification_title_does_not_match_page_video"
        };
        searchEvent = {
          ...event,
          videoId: ""
        };
      }
    }
    const candidates = await findYouTubeVideoCandidates({
      title: searchEvent.videoTitle,
      channel: searchEvent.channel,
      channelId: searchEvent.channelId,
      apiKey: youtubeApiKey,
      limit: 3
    });
    const candidate = candidates.find((item) => isTrustedYouTubeCandidate(searchEvent, item)) || null;
    if (!candidate) {
      return {
        event: {
          ...searchEvent,
          youtubeCandidates: candidates
        },
        summary: {
          source: "youtube_search",
          resolved: false,
          rejectedVideoContext,
          candidates
        }
      };
    }
    return {
      event: {
        ...searchEvent,
        videoId: candidate.videoId,
        channelId: searchEvent.channelId || candidate.channelId || "",
        channel: searchEvent.channel || candidate.channel || "",
        youtubeCandidates: candidates
      },
      summary: {
        source: "youtube_search",
        resolved: true,
        videoId: candidate.videoId,
        title: candidate.title,
        channel: candidate.channel,
        channelId: candidate.channelId || "",
        score: candidate.score,
        rejectedVideoContext,
        candidates
      }
    };
  } catch (error) {
    return {
      event,
      summary: {
        source: "youtube_search",
        resolved: false,
        error: error.message,
        candidates: []
      }
    };
  }
}

async function ensureAppManagedRun({ sql, event, youtubeApiKey = "" }) {
  if (!event?.videoId && !event?.videoTitle) return null;
  let metadata = {};
  let managedEvent = { ...event };
  let rejectedVideoContext = null;
  if (event.videoId && youtubeApiKey) {
    const found = await fetchYouTubeVideoMetadata([event.videoId], youtubeApiKey).catch(() => ({}));
    metadata = found[event.videoId] || {};
    if (metadata.title && !notificationTitleMatchesVideoMetadata(event, metadata)) {
      rejectedVideoContext = {
        videoId: event.videoId,
        title: metadata.title,
        reason: "notification_title_does_not_match_page_video"
      };
      managedEvent = {
        ...event,
        videoId: ""
      };
      metadata = {};
    }
  }
  const identity = appManagedRunIdentity({
    ...managedEvent,
    videoId: managedEvent.videoId || metadata.videoId || "",
    videoTitle: managedEvent.videoTitle || metadata.title || "",
    channelId: managedEvent.channelId || metadata.channelId || "",
    channel: metadata.channelTitle || managedEvent.channel || ""
  });
  const testType = identity.testType;
  const videoId = managedEvent.videoId || metadata.videoId || "";
  const videoTitle = managedEvent.videoTitle || metadata.title || videoId || "Finished A/B test";
  const channelId = managedEvent.channelId || metadata.channelId || "";
  const channel = canonicalChannelName(metadata.channelTitle || managedEvent.channel) || metadata.channelTitle || managedEvent.channel || "Unknown source";
  const existingRuns = await sql`
    WITH input AS (
      SELECT
        CAST(${testType} AS text) AS test_type,
        CAST(${videoId} AS text) AS video_id,
        CAST(${videoTitle} AS text) AS video_title,
        CAST(${channel} AS text) AS channel_name
    )
    SELECT tr.test_run_id, tr.test_id
    FROM test_runs tr
    CROSS JOIN input
    WHERE tr.source_kind = 'app_registry'
      AND tr.status <> 'source_removed'
      AND tr.test_type = input.test_type
      AND (
        (input.video_id <> '' AND tr.video_id = input.video_id)
        OR (
          input.video_title <> ''
          AND (
            input.video_id = ''
            OR tr.video_id = ''
          )
          AND LOWER(TRIM(COALESCE(NULLIF(tr.current_youtube_title, ''), tr.video_title))) = LOWER(TRIM(input.video_title))
          AND (
            LOWER(TRIM(tr.channel)) = LOWER(TRIM(input.channel_name))
            OR LOWER(TRIM(tr.channel)) IN ('', 'unknown source')
            OR LOWER(TRIM(input.channel_name)) IN ('', 'unknown source')
          )
        )
      )
    ORDER BY tr.updated_at DESC
    LIMIT 1
  `;
  const testRunId = existingRuns[0]?.test_run_id || identity.testRunId;
  const studioUrl = videoId
    ? `https://studio.youtube.com/video/${videoId}/edit`
    : "";
  const detectedOutcome = managedEvent.detectedOutcome || "finished_unknown";
  const canonicalResult = projectCanonicalResult({
    result: managedEvent.result,
    resultEvidence: managedEvent.resultEvidence,
    resultSemanticsVersion: managedEvent.resultSemanticsVersion,
    explicitWinnerVariant: managedEvent.explicitWinnerVariant,
    detectedOutcome,
    finishEventText: managedEvent.rawText,
    finishEventSource: managedEvent.source
  });
  const suggestedWinner = "";
  const managedRecord = {
    testRunId,
    testId: existingRuns[0]?.test_id || "",
    videoId,
    sourceKind: "app_registry",
    spreadsheetId: "",
    sheetName: "App registry",
    rowNumber: 0,
    testType,
    channel,
    videoTitle,
    startDate: "",
    finishDate: "",
    options: {},
    status: "needs_review",
    result: canonicalResult.result,
    resultEvidence: canonicalResult.resultEvidence,
    resultSemanticsVersion: canonicalResult.resultSemanticsVersion,
    explicitWinnerVariant: canonicalResult.explicitWinnerVariant,
    highestShareVariant: "",
    inconclusiveReason: canonicalResult.inconclusiveReason,
    inconclusiveReasonEvidence: canonicalResult.inconclusiveReasonEvidence
  };
  managedRecord.contentHash = testContentHash(managedRecord);
  await assignPersistentTestIds(sql, [managedRecord]);
  const sourcePayload = {
    registry: "app",
    event: {
      source: managedEvent.source || "studio_bell",
      rawText: managedEvent.rawText || "",
      notificationAge: managedEvent.notificationAge || "",
      occurredAt: managedEvent.occurredAt || ""
    },
    rejectedVideoContext
  };
  await sql`
    INSERT INTO test_runs (
      test_run_id, test_id, content_hash, video_id, source_kind, spreadsheet_id, sheet_name, row_number,
      test_type, channel, video_title, video_url, studio_url, status, detected_outcome,
      suggested_winner, winner_reason, result, result_evidence, result_semantics_version,
      explicit_winner_variant, highest_share_variant, inconclusive_reason,
      inconclusive_reason_evidence, options, watch_time_share, troubles,
      thumbnail_previews, current_youtube_title, current_youtube_thumbnail_url,
      youtube_channel_id, youtube_channel_title, youtube_channel_thumbnail_url,
      option_fingerprint, row_fingerprint, source_payload_hash, source_payload,
      updated_at, possible_retest
    ) VALUES (
      ${testRunId}, ${managedRecord.testId}, ${managedRecord.contentHash}, ${videoId}, 'app_registry', '', 'App registry', 0,
      ${testType}, ${channel}, ${videoTitle},
      ${videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""}, ${studioUrl},
      'needs_review', ${detectedOutcome}, ${suggestedWinner},
      'Studio confirmed this test finished; the app is tracking it independently until a sheet row is available.',
      ${canonicalResult.result}, ${canonicalResult.resultEvidence},
      ${canonicalResult.resultSemanticsVersion}, ${canonicalResult.explicitWinnerVariant},
      '', ${canonicalResult.inconclusiveReason}, ${canonicalResult.inconclusiveReasonEvidence},
      '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
      ${metadata.title || videoTitle}, ${metadata.thumbnailUrl || ""},
      ${channelId}, ${metadata.channelTitle || channel}, '', '', '',
      ${identity.identityHash},
      ${toJson(sourcePayload)}::jsonb, NOW(), FALSE
    )
    ON CONFLICT (test_run_id)
    DO UPDATE SET
      test_id = COALESCE(test_runs.test_id, EXCLUDED.test_id),
      content_hash = EXCLUDED.content_hash,
      video_id = CASE WHEN test_runs.video_id = '' THEN EXCLUDED.video_id ELSE test_runs.video_id END,
      channel = CASE WHEN test_runs.channel = '' OR test_runs.channel = 'Unknown source' THEN EXCLUDED.channel ELSE test_runs.channel END,
      video_title = CASE WHEN test_runs.video_title = '' THEN EXCLUDED.video_title ELSE test_runs.video_title END,
      video_url = CASE WHEN test_runs.video_url = '' THEN EXCLUDED.video_url ELSE test_runs.video_url END,
      studio_url = CASE WHEN test_runs.studio_url = '' THEN EXCLUDED.studio_url ELSE test_runs.studio_url END,
      detected_outcome = EXCLUDED.detected_outcome,
      suggested_winner = EXCLUDED.suggested_winner,
      result = EXCLUDED.result,
      result_evidence = EXCLUDED.result_evidence,
      result_semantics_version = EXCLUDED.result_semantics_version,
      explicit_winner_variant = EXCLUDED.explicit_winner_variant,
      inconclusive_reason = EXCLUDED.inconclusive_reason,
      inconclusive_reason_evidence = EXCLUDED.inconclusive_reason_evidence,
      current_youtube_title = CASE WHEN EXCLUDED.current_youtube_title <> '' THEN EXCLUDED.current_youtube_title ELSE test_runs.current_youtube_title END,
      current_youtube_thumbnail_url = CASE WHEN EXCLUDED.current_youtube_thumbnail_url <> '' THEN EXCLUDED.current_youtube_thumbnail_url ELSE test_runs.current_youtube_thumbnail_url END,
      youtube_channel_id = CASE WHEN EXCLUDED.youtube_channel_id <> '' THEN EXCLUDED.youtube_channel_id ELSE test_runs.youtube_channel_id END,
      youtube_channel_title = CASE WHEN EXCLUDED.youtube_channel_title <> '' THEN EXCLUDED.youtube_channel_title ELSE test_runs.youtube_channel_title END,
      source_payload = EXCLUDED.source_payload,
      updated_at = NOW()
  `;
  await persistIdentityLinks(sql, [{
    test_run_id: testRunId,
    test_id: managedRecord.testId,
    content_hash: managedRecord.contentHash,
    identity_match: managedRecord.identityMatch,
    source_kind: "app_registry",
    spreadsheet_id: "",
    sheet_name: "App registry",
    row_number: 0,
    video_id: videoId,
    test_type: testType,
    start_date: "",
    options: {}
  }]);
  return {
    testRunId,
    testId: managedRecord.testId,
    videoId,
    sourceKind: "app_registry",
    sheetName: "App registry",
    rowNumber: 0,
    testType,
    channel,
    videoTitle,
    currentYoutubeTitle: metadata.title || videoTitle,
    youtubeChannelId: channelId,
    youtubeChannelTitle: metadata.channelTitle || channel,
    options: {},
    status: "needs_review"
  };
}

function resolvedMatchedConfidence(base, youtubeResolution) {
  if (youtubeResolution?.summary?.resolved && base === "video_id") return "youtube_search_video_id";
  if (youtubeResolution?.summary?.resolved && base) return `youtube_search_${base}`;
  return base || "unmatched";
}

function isTrustedYouTubeCandidate(event, candidate) {
  if (!candidate?.videoId) return false;
  const score = Number(candidate.score || 0);
  if (score >= 0.95) return true;
  const eventChannelId = String(event.channelId || "").trim();
  if (eventChannelId && candidate.channelId && eventChannelId === candidate.channelId && score >= 0.76) return true;
  if (score >= 0.84 && relatedChannelName(event.channel, candidate.channel)) return true;
  return false;
}

function relatedChannelName(left, right) {
  const a = canonicalChannelName(left);
  const b = canonicalChannelName(right);
  return Boolean(a && b && normalizeMatchText(a) === normalizeMatchText(b));
}

async function insertFinishEvent({ event, testRunId, matchedConfidence, processingStatus, actorName }) {
  const sql = getSql();
  const linkedRunId = testRunId || event.testRunId || "";
  const linkedTests = linkedRunId
    ? await sql`SELECT test_id FROM test_runs WHERE test_run_id = ${linkedRunId} LIMIT 1`
    : [];
  const canonicalResult = projectCanonicalResult({
    result: event.result,
    resultEvidence: event.resultEvidence,
    resultSemanticsVersion: event.resultSemanticsVersion,
    explicitWinnerVariant: event.explicitWinnerVariant,
    inconclusiveReason: event.inconclusiveReason,
    inconclusiveReasonEvidence: event.inconclusiveReasonEvidence,
    detectedOutcome: event.detectedOutcome,
    finishEventText: event.rawText,
    finishEventSource: event.source
  });
  const hash = finishEventHash({ ...event, testRunId });
  const eventId = `fe_${hash.slice(0, 24)}`;
  const rows = await sql`
    INSERT INTO finish_events (
      event_id,
      event_hash,
        test_run_id,
        test_id,
        video_id,
        channel_id,
        channel,
        source,
        raw_text,
        notification_url,
        notification_age,
        matched_confidence,
      detected_outcome,
      result,
      result_evidence,
      result_semantics_version,
      explicit_winner_variant,
      youtube_applied_variant,
      inconclusive_reason,
      inconclusive_reason_evidence,
      processing_status,
      actor_name,
        payload,
        occurred_at,
        observed_at,
      updated_at
    )
    VALUES (
        ${eventId},
        ${hash},
        ${testRunId || event.testRunId || ""},
        ${linkedTests[0]?.test_id || event.testId || null},
        ${event.videoId || ""},
        ${event.channelId || ""},
        ${event.channel || ""},
        ${event.source || "studio_bell"},
        ${event.rawText || ""},
        ${event.url || ""},
        ${notificationAgeLabel(event.notificationAge)},
        ${matchedConfidence || ""},
      ${event.detectedOutcome || ""},
      ${canonicalResult.result},
      ${canonicalResult.resultEvidence},
      ${canonicalResult.resultSemanticsVersion},
      ${canonicalResult.explicitWinnerVariant},
      ${event.youtubeAppliedVariant || ""},
      ${canonicalResult.inconclusiveReason || ""},
      ${canonicalResult.inconclusiveReasonEvidence || ""},
      ${processingStatus || "unmatched"},
      ${actorName || ""},
      ${toJson(event)}::jsonb,
      ${event.occurredAt || null},
      ${event.observedAt || new Date().toISOString()},
      NOW()
    )
    ON CONFLICT (event_hash)
    DO UPDATE SET
      test_run_id = CASE
        WHEN finish_events.test_run_id = '' AND EXCLUDED.test_run_id <> '' THEN EXCLUDED.test_run_id
        ELSE finish_events.test_run_id
      END,
      test_id = COALESCE(finish_events.test_id, EXCLUDED.test_id),
        matched_confidence = CASE
          WHEN finish_events.matched_confidence = '' AND EXCLUDED.matched_confidence <> '' THEN EXCLUDED.matched_confidence
          ELSE finish_events.matched_confidence
        END,
        video_id = CASE
          WHEN finish_events.video_id = '' AND EXCLUDED.video_id <> '' THEN EXCLUDED.video_id
          ELSE finish_events.video_id
        END,
        channel_id = CASE
          WHEN finish_events.channel_id = '' AND EXCLUDED.channel_id <> '' THEN EXCLUDED.channel_id
          ELSE finish_events.channel_id
        END,
        notification_age = CASE
          WHEN EXCLUDED.notification_age <> '' THEN EXCLUDED.notification_age
          ELSE finish_events.notification_age
        END,
      processing_status = CASE
        WHEN finish_events.processing_status = 'unmatched' AND EXCLUDED.processing_status = 'matched' THEN 'matched'
        ELSE finish_events.processing_status
      END,
      detected_outcome = CASE
        WHEN finish_events.detected_outcome IN ('', 'unknown') AND EXCLUDED.detected_outcome NOT IN ('', 'unknown')
          THEN EXCLUDED.detected_outcome
        ELSE finish_events.detected_outcome
      END,
      result = CASE
        WHEN finish_events.result_evidence IN ('studio_explicit', 'sheet_explicit')
          THEN finish_events.result
        ELSE EXCLUDED.result
      END,
      result_evidence = CASE
        WHEN finish_events.result_evidence IN ('studio_explicit', 'sheet_explicit')
          THEN finish_events.result_evidence
        ELSE EXCLUDED.result_evidence
      END,
      result_semantics_version = EXCLUDED.result_semantics_version,
      explicit_winner_variant = CASE
        WHEN finish_events.explicit_winner_variant <> '' THEN finish_events.explicit_winner_variant
        ELSE EXCLUDED.explicit_winner_variant
      END,
      youtube_applied_variant = CASE
        WHEN EXCLUDED.youtube_applied_variant <> '' THEN EXCLUDED.youtube_applied_variant
        ELSE finish_events.youtube_applied_variant
      END,
      inconclusive_reason = CASE
        WHEN EXCLUDED.inconclusive_reason <> '' THEN EXCLUDED.inconclusive_reason
        ELSE finish_events.inconclusive_reason
      END,
      inconclusive_reason_evidence = CASE
        WHEN EXCLUDED.inconclusive_reason_evidence <> '' THEN EXCLUDED.inconclusive_reason_evidence
        ELSE finish_events.inconclusive_reason_evidence
      END,
      occurred_at = COALESCE(finish_events.occurred_at, EXCLUDED.occurred_at),
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING *
  `;
  const linkedTestId = linkedTests[0]?.test_id || event.testId || "";
  if (linkedTestId && canonicalResult.resultEvidence === "studio_explicit") {
    await sql`
      UPDATE logical_tests
      SET result = ${canonicalResult.result},
          result_evidence = ${canonicalResult.resultEvidence},
          result_semantics_version = ${canonicalResult.resultSemanticsVersion},
          explicit_winner_variant = ${canonicalResult.explicitWinnerVariant},
          youtube_applied_variant = CASE
            WHEN ${event.youtubeAppliedVariant || ""} <> '' THEN ${event.youtubeAppliedVariant || ""}
            ELSE youtube_applied_variant
          END,
          inconclusive_reason = ${canonicalResult.inconclusiveReason},
          inconclusive_reason_evidence = ${canonicalResult.inconclusiveReasonEvidence},
          lifecycle_status = 'finished',
          updated_at = NOW()
      WHERE test_id = ${linkedTestId}
    `;
  } else if (linkedTestId && event.youtubeAppliedVariant) {
    await sql`
      UPDATE logical_tests
      SET youtube_applied_variant = ${event.youtubeAppliedVariant},
          updated_at = NOW()
      WHERE test_id = ${linkedTestId}
    `;
  }
  return rows[0] || null;
}

export async function saveThumbnailPreview({ sourceKind, sheetName, rowNumber, option, url, contentType, uploadId }) {
  await ensureSchema();
  const sql = getSql();
  const previewId = crypto
    .createHash("sha1")
    .update(`${sourceKind}|${sheetName}|${rowNumber}|${option}`)
    .digest("hex");
  await sql`
    INSERT INTO thumbnail_previews (
      preview_id,
      source_kind,
      sheet_name,
      row_number,
      option_key,
      url,
      content_type,
      upload_id,
      updated_at
    )
    VALUES (
      ${previewId},
      ${sourceKind},
      ${sheetName},
      ${rowNumber},
      ${option},
      ${url},
      ${contentType || "image/png"},
      ${uploadId || ""},
      NOW()
    )
    ON CONFLICT (source_kind, sheet_name, row_number, option_key)
    DO UPDATE SET
      url = EXCLUDED.url,
      content_type = EXCLUDED.content_type,
      upload_id = EXCLUDED.upload_id,
      updated_at = NOW()
  `;
}

export async function saveUpload({ uploadId, filename, sourceKind, importedCount }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO uploads (upload_id, filename, source_kind, imported_count)
    VALUES (${uploadId}, ${filename}, ${sourceKind}, ${importedCount})
  `;
}

export async function listUploads() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT upload_id, filename, source_kind, imported_count, created_at
    FROM uploads
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map((row) => ({
    uploadId: row.upload_id,
    filename: row.filename,
    sourceKind: row.source_kind,
    importedCount: row.imported_count,
    createdAt: row.created_at
  }));
}

export function summarizeQueue(runs) {
  const summary = {
    total: runs.length,
    newlyFinished: 0,
    confirmedFinished: 0,
    appliedChangeObserved: 0,
    pastDueCheck: 0,
    uncovered: 0,
    watching: 0,
    needsReview: 0,
    missingData: 0,
    sheetChangedAfterDone: 0,
    actionConflict: 0,
    possibleRetest: 0,
    unregisteredSignals: 0,
    appManagedRuns: 0,
    mergedDuplicateRows: 0
  };
  for (const run of runs) {
    summary.mergedDuplicateRows += Number(run.duplicateCount || 0);
    if (run.sourceKind === "app_registry") summary.appManagedRuns += 1;
    if (run.unregistered) summary.unregisteredSignals += 1;
    if (run.queueStatus === "action_conflict") summary.actionConflict += 1;
    else if (run.queueStatus === "sheet_changed_after_done") summary.sheetChangedAfterDone += 1;
    else if (run.queueStatus === "confirmed_finished") {
      summary.confirmedFinished += 1;
      summary.needsReview += 1;
      summary.newlyFinished += 1;
    }
    else if (run.queueStatus === "applied_change_observed") summary.appliedChangeObserved += 1;
    else if (run.queueStatus === "past_due_check") summary.pastDueCheck += 1;
    else if (run.queueStatus === "uncovered") summary.uncovered += 1;
    else if (run.queueStatus === "watching") summary.watching += 1;
    else if (run.status === "missing_data") summary.missingData += 1;
    if (run.possibleRetest) summary.possibleRetest += 1;
  }
  return summary;
}

async function activeConnectorCoverage() {
  const status = await getConnectorStatus();
  const active = status.filter((item) => item.active);
  const map = new Map();
    for (const item of active) {
      for (const channel of item.channels || []) {
        const key = connectorCoverageKey(channel);
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || new Date(item.lastSeenAt) > new Date(existing.lastSeenAt)) {
          map.set(key, item);
        }
      }
      for (const tab of item.payload?.studioTabs || []) {
        for (const key of [connectorCoverageKey(tab.channel), connectorChannelIdKey(tab.channelId)]) {
          if (!key) continue;
          const existing = map.get(key);
          if (!existing || new Date(item.lastSeenAt) > new Date(existing.lastSeenAt)) {
            map.set(key, item);
          }
        }
      }
    }
  return map;
}

function applyConnectorCoverage(run, coverage) {
  const covered = coverage.get(connectorChannelIdKey(run.youtubeChannelId)) || coverage.get(connectorCoverageKey(run.channel));
  const next = {
    ...run,
    connectorCovered: Boolean(covered),
    connectorLastSeenAt: covered?.lastSeenAt || "",
    connectorActorName: covered?.actorName || ""
  };
  if (next.queueStatus === "running") {
    next.queueStatus = covered ? "watching" : "uncovered";
  }
  return next;
}

function connectorCoverageKey(channel) {
  return normalizeMatchText(canonicalChannelName(channel) || channel);
}

function connectorChannelIdKey(channelId) {
  const text = String(channelId || "").trim();
  return /^UC[A-Za-z0-9_-]{10,}$/.test(text) ? `id:${text}` : "";
}

function runRow(row) {
  const drifted = Boolean(row.drifted_at);
  const hasAction = Boolean(row.latest_action || row.action);
  const validFinishEvent = isValidQueueFinishEvent(row);
  const finishEventSource = validFinishEvent ? row.finish_event_source || "" : "";
  const finishEventStatus = finishEventSource
    ? finishEventSource === "metadata"
      ? "applied_change_observed"
      : "confirmed_finished"
    : "";
  const baseQueueStatus = finishEventStatus || (row.status === "needs_review" ? "confirmed_finished" : row.status);
  const canonicalResult = projectCanonicalResult({
    result: row.result,
    resultEvidence: row.result_evidence,
    resultSemanticsVersion: row.result_semantics_version,
    explicitWinnerVariant: row.explicit_winner_variant,
    detectedOutcome: row.detected_outcome,
    suggestedWinner: row.suggested_winner,
    winnerReason: row.winner_reason,
    finishEventText: validFinishEvent ? row.finish_event_text : "",
    finishEventOutcome: validFinishEvent ? row.finish_event_outcome : "",
    finishEventSource,
    shares: fromJson(row.watch_time_share, {}),
    options: fromJson(row.options, {})
  });
  const queueStatus = deriveQueueStatus({
    drifted,
    hasAction,
    baseQueueStatus,
    startDate: row.start_date,
    latestAction: row.latest_action || row.action || "",
    result: canonicalResult.result,
    resultEvidence: canonicalResult.resultEvidence,
    explicitWinnerVariant: canonicalResult.explicitWinnerVariant
  });
  return {
    testRunId: row.test_run_id,
    testId: row.test_id || "",
    videoId: row.video_id,
    sourceKind: row.source_kind,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    rowNumber: row.row_number,
    testType: row.test_type,
    channel: row.channel,
    videoTitle: row.video_title,
    videoUrl: row.video_url,
    studioUrl: row.studio_url,
    startDate: formatDateOnly(row.start_date),
    finishDate: formatDateOnly(row.finish_date),
    effectiveFinishDate: formatDateOnly(row.effective_finish_date),
    overdueDays: row.overdue_days,
    status: row.status,
    queueStatus,
    detectedOutcome: row.detected_outcome,
    suggestedWinner: row.suggested_winner,
    winnerReason: row.winner_reason,
    result: canonicalResult.result,
    resultEvidence: canonicalResult.resultEvidence,
    resultSemanticsVersion: canonicalResult.resultSemanticsVersion,
    explicitWinnerVariant: canonicalResult.explicitWinnerVariant,
    highestShareVariant:
      row.highest_share_variant || canonicalResult.highestShareVariant || "",
    configuredVariantCount: canonicalResult.configuredVariantCount || 0,
    populatedShareCount: canonicalResult.populatedShareCount || 0,
    shareSum: canonicalResult.shareSum,
    shareSumValid: Boolean(canonicalResult.shareSumValid),
    shareQuality: canonicalResult.quality || "",
    operationalDecision: row.operational_decision || "",
    youtubeAppliedVariant: row.youtube_applied_variant || "",
    inconclusiveReason:
      row.inconclusive_reason || canonicalResult.inconclusiveReason || "",
    inconclusiveReasonEvidence:
      row.inconclusive_reason_evidence ||
      canonicalResult.inconclusiveReasonEvidence ||
      "",
    options: fromJson(row.options, {}),
    watchTimeShare: fromJson(row.watch_time_share, {}),
    troubles: fromJson(row.troubles, []),
    thumbnailPreviews: displayThumbnailPreviews(fromJson(row.thumbnail_previews, {})),
      currentYoutubeTitle: row.current_youtube_title,
      currentYoutubeThumbnailUrl: row.current_youtube_thumbnail_url,
      youtubeChannelId: row.youtube_channel_id || "",
      youtubeChannelTitle: row.youtube_channel_title,
      youtubeChannelThumbnailUrl: row.youtube_channel_thumbnail_url || "",
    optionFingerprint: row.option_fingerprint || "",
    rowFingerprint: row.row_fingerprint || "",
    possibleRetest: Boolean(row.possible_retest),
    driftedAt: row.drifted_at,
    driftReason: row.drift_reason,
    latestAction: row.latest_action || "",
    latestActor: row.latest_actor || "",
    latestActionAt: row.latest_action_at || "",
    finishEventId: row.finish_event_id || "",
    finishEventValid: validFinishEvent,
    finishEventVideoId: row.finish_event_video_id || "",
    finishEventSource,
    finishEventText: row.finish_event_text || "",
      finishEventUrl: row.finish_event_url || "",
      finishEventChannelId: row.finish_event_channel_id || "",
      finishEventNotificationAge: row.finish_event_notification_age || "",
    finishEventOutcome: row.finish_event_outcome || "",
    finishEventOccurredAt: resolveEventOccurredAt({
      occurredAt: row.finish_event_occurred_at || "",
      observedAt: row.finish_event_at || "",
      notificationAge: row.finish_event_notification_age || ""
    }),
    finishEventAt: row.finish_event_at || "",
    matchedConfidence: row.matched_confidence || "",
    connectorCovered: false,
    connectorLastSeenAt: "",
    connectorActorName: ""
  };
}

function activeQueueRun(run) {
  if (run.sourceKind === "app_registry" && !run.finishEventValid) return false;
  if (run.queueStatus === "action_conflict") return true;
  if (["running", "scheduled"].includes(run.queueStatus) && isFutureDate(run.startDate)) return false;
  if (["running", "scheduled", "missing_data"].includes(run.queueStatus) && isPreYouTubeDate(run.startDate)) return false;
  return !["scheduled", "done", "sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(run.queueStatus);
}

function isFutureDate(value) {
  const day = formatDateOnly(value);
  if (!day) return false;
  return day > formatDateOnly(new Date());
}

function isPreYouTubeDate(value) {
  const day = formatDateOnly(value);
  return Boolean(day && day < "2005-01-01");
}

function isValidQueueFinishEvent(row) {
  const source = row.finish_event_source || "";
  if (!source) return false;
  if (source === "metadata") return true;
  const outcome = row.finish_event_outcome || "";
  if (!outcome || outcome === "unknown") return false;
  if (!isLikelyFinishNotification(row.finish_event_text || "")) return false;
  const event = parseStudioNotification({
    rawText: row.finish_event_text || "",
    videoId: row.finish_event_video_id || "",
    channel: row.channel || "",
    channelId: row.finish_event_channel_id || ""
  });
  if (!isPromotableStudioFinishEvent(event)) return false;
  if (event.videoId && row.video_id && event.videoId !== row.video_id) return false;
  const eventTitle = normalizeMatchText(event.videoTitle);
  if (eventTitle && !eventTitleMatchesRun(eventTitle, runRowTitleShape(row))) return false;
  return true;
}

function runRowTitleShape(row) {
  return {
    videoTitle: row.video_title || "",
    currentYoutubeTitle: row.current_youtube_title || "",
    options: fromJson(row.options, {})
  };
}

function scanRow(row) {
  return {
    scanId: row.scan_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    summary: fromJson(row.summary, {}),
    progress: fromJson(row.progress, {}),
    warnings: fromJson(row.warnings, []),
    actorName: row.actor_name
  };
}

function scanProgressSteps(activeStage = "") {
  const steps = [
    ["starting", "Prepare"],
    ["read_sheets", "Read sheets"],
    ["thumbnail_previews", "Thumbnail previews"],
    ["youtube_metadata", "YouTube data"],
    ["save_runs", "Save results"],
    ["finish_signals", "Finish signals"],
    ["complete", "Complete"]
  ];
  const activeIndex = steps.findIndex(([stage]) => stage === activeStage);
  return steps.map(([stage, label], index) => ({
    stage,
    label,
    state: activeStage === "complete"
      ? "done"
      : activeStage === "failed"
      ? index < steps.length - 1 ? "done" : "failed"
      : activeIndex < 0
        ? "pending"
        : index < activeIndex
          ? "done"
          : index === activeIndex
            ? "active"
            : "pending"
  }));
}

function notificationAgeLabel(value) {
  if (!value) return "";
  if (typeof value === "object") {
    if (value.label) return String(value.label);
    if (Number.isFinite(Number(value.days))) {
      const days = Number(value.days);
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    return "";
  }
  const text = String(value);
  if (text.startsWith("{")) {
    try {
      return notificationAgeLabel(JSON.parse(text));
    } catch {}
  }
  return text;
}

function displayThumbnailPreviews(previews) {
  return Object.fromEntries(
    Object.entries(previews || {}).map(([option, url]) => [option, previewDisplayUrl(url)])
  );
}

function isRecent(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return false;
  return Date.now() - date.valueOf() < 3 * 60 * 60 * 1000;
}
