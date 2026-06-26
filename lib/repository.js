import crypto from "node:crypto";
import { ensureSchema, fromJson, getSql, toJson } from "@/lib/db.js";
import {
  detectAppliedChange,
  finishEventHash,
  isLikelyFinishNotification,
  matchFinishEventToRun,
  normalizeMatchText,
  parseStudioNotification
} from "@/lib/finish-events.mjs";

export async function createScanRun({ actorName }) {
  await ensureSchema();
  const sql = getSql();
  const scanId = crypto.randomUUID();
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
  return scanId;
}

export async function completeScanRun({ scanId, status, summary, warnings }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE scan_runs
    SET completed_at = NOW(),
        status = ${status},
        summary = ${toJson(summary)}::jsonb,
        progress = ${toJson({
          stage: status === "ok" ? "complete" : "failed",
          label: status === "ok" ? "Scan complete" : "Scan failed",
          detail: status === "ok" ? "Queue and counts are updated." : summary?.error || "Scan failed.",
          percent: 100,
          steps: scanProgressSteps(status === "ok" ? "complete" : "failed"),
          updatedAt: new Date().toISOString()
        })}::jsonb,
        warnings = ${toJson(warnings || [])}::jsonb
    WHERE scan_id = ${scanId}
  `;
}

export async function updateScanProgress({ scanId, stage, label, detail = "", percent = 0, counts = {} }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
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
  `;
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

export async function upsertScannedRuns({ records, scanId }) {
  await ensureSchema();
  const sql = getSql();
  for (const record of records) {
    const existing = await sql`
      SELECT tr.source_payload_hash,
             tr.drifted_at,
             EXISTS (
               SELECT 1 FROM test_actions ta WHERE ta.test_run_id = tr.test_run_id
             ) AS has_action
      FROM test_runs tr
      WHERE tr.test_run_id = ${record.testRunId}
      LIMIT 1
    `;
    const current = existing[0];
    const hasAction = Boolean(current?.has_action);
    const changedAfterDone =
      hasAction &&
      current?.source_payload_hash &&
      current.source_payload_hash !== record.sourcePayloadHash;
    const driftedAt = changedAfterDone ? new Date().toISOString() : null;
    const driftReason = changedAfterDone ? "source_changed_after_done" : "";
    const previousHash = changedAfterDone ? current.source_payload_hash : "";

    await sql`
      INSERT INTO test_runs (
        test_run_id,
        video_id,
        source_kind,
        spreadsheet_id,
        sheet_name,
        row_number,
        test_type,
        channel,
        video_title,
        video_url,
        studio_url,
        start_date,
        finish_date,
        effective_finish_date,
        overdue_days,
        status,
        detected_outcome,
        suggested_winner,
        winner_reason,
        options,
        watch_time_share,
        troubles,
        thumbnail_previews,
        current_youtube_title,
        current_youtube_thumbnail_url,
        youtube_channel_title,
        youtube_channel_thumbnail_url,
        option_fingerprint,
        row_fingerprint,
        source_payload_hash,
        source_payload,
        updated_at,
        last_seen_scan_id,
        drifted_at,
        drift_reason,
        previous_source_payload_hash
      )
      VALUES (
        ${record.testRunId},
        ${record.videoId || ""},
        ${record.sourceKind},
        ${record.spreadsheetId},
        ${record.sheetName},
        ${record.rowNumber},
        ${record.testType},
        ${record.channel || record.sheetName || ""},
        ${record.videoTitle || ""},
        ${record.videoUrl || ""},
        ${record.studioUrl || ""},
        ${record.startDate || null},
        ${record.finishDate || null},
        ${record.effectiveFinishDate || null},
        ${record.overdueDays || 0},
        ${record.status},
        ${record.detectedOutcome},
        ${record.suggestedWinner || ""},
        ${record.winnerReason || ""},
        ${toJson(record.options)}::jsonb,
        ${toJson(record.watchTimeShare)}::jsonb,
        ${toJson(record.troubles)}::jsonb,
        ${toJson(record.thumbnailPreviews || {})}::jsonb,
        ${record.currentYoutubeTitle || ""},
        ${record.currentYoutubeThumbnailUrl || ""},
        ${record.youtubeChannelTitle || ""},
        ${record.youtubeChannelThumbnailUrl || ""},
        ${record.optionFingerprint || ""},
        ${record.rowFingerprint || ""},
        ${record.sourcePayloadHash || ""},
        ${toJson(record.sourcePayload)}::jsonb,
        NOW(),
        ${scanId},
        ${driftedAt},
        ${driftReason},
        ${previousHash}
      )
      ON CONFLICT (test_run_id)
      DO UPDATE SET
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
        options = EXCLUDED.options,
        watch_time_share = EXCLUDED.watch_time_share,
        troubles = EXCLUDED.troubles,
        thumbnail_previews = EXCLUDED.thumbnail_previews,
        current_youtube_title = EXCLUDED.current_youtube_title,
        current_youtube_thumbnail_url = EXCLUDED.current_youtube_thumbnail_url,
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
    `;
  }

  await sql`
    UPDATE test_runs current
    SET possible_retest = EXISTS (
      SELECT 1
      FROM test_runs other
      WHERE other.video_id = current.video_id
        AND other.video_id <> ''
        AND other.test_run_id <> current.test_run_id
    )
  `;
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

export async function flagMissingCompletedRuns({ scanId, sourceKinds }) {
  await ensureSchema();
  const sql = getSql();
  for (const sourceKind of sourceKinds) {
    await sql`
      UPDATE test_runs tr
      SET drifted_at = COALESCE(tr.drifted_at, NOW()),
          drift_reason = CASE WHEN tr.drift_reason = '' THEN 'source_missing_after_done' ELSE tr.drift_reason END
      WHERE tr.source_kind = ${sourceKind}
        AND tr.last_seen_scan_id IS DISTINCT FROM ${scanId}
        AND EXISTS (SELECT 1 FROM test_actions ta WHERE ta.test_run_id = tr.test_run_id)
    `;
  }
}

export async function loadThumbnailPreviewMap() {
  await ensureSchema();
  await cleanupInlineThumbnailData();
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
  await cleanupInlineThumbnailData();
  const sql = getSql();
  const coverage = await activeConnectorCoverage();
  const rows = await sql`
    WITH latest_action AS (
      SELECT DISTINCT ON (test_run_id)
        test_run_id,
        action_id,
        action,
        actor_name,
        created_at
      FROM test_actions
      ORDER BY test_run_id, created_at DESC
    ),
    latest_event AS (
      SELECT DISTINCT ON (test_run_id)
        test_run_id,
        event_id,
        source,
        raw_text,
        notification_url,
        matched_confidence,
        detected_outcome,
        processing_status,
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
        CASE WHEN source = 'metadata' THEN 2 ELSE 1 END,
        observed_at DESC
    )
    SELECT
      tr.test_run_id,
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
      tr.options,
      tr.watch_time_share,
      tr.troubles,
      tr.thumbnail_previews,
      tr.current_youtube_title,
      tr.current_youtube_thumbnail_url,
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
      le.source AS finish_event_source,
      le.raw_text AS finish_event_text,
      le.notification_url AS finish_event_url,
      le.matched_confidence AS matched_confidence,
      le.detected_outcome AS finish_event_outcome,
      le.processing_status AS finish_event_processing_status,
      le.observed_at AS finish_event_at
    FROM test_runs tr
    LEFT JOIN latest_action la ON la.test_run_id = tr.test_run_id
    LEFT JOIN latest_event le ON le.test_run_id = tr.test_run_id
    WHERE (
      la.action IS NULL
      AND tr.status NOT IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
    )
    OR (
      la.action IS NOT NULL
      AND tr.drifted_at IS NOT NULL
    )
    ORDER BY LOWER(tr.channel), tr.finish_date DESC NULLS LAST, tr.updated_at DESC, tr.row_number
    LIMIT 1000
  `;
  return rows.map((row) => applyConnectorCoverage(runRow(row), coverage));
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
      tr.options,
      tr.watch_time_share,
      tr.troubles,
      tr.thumbnail_previews,
      tr.current_youtube_title,
      tr.current_youtube_thumbnail_url,
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
      ta.created_at AS action_created_at
    FROM test_actions ta
    JOIN test_runs tr ON tr.test_run_id = ta.test_run_id
    WHERE ${!search} OR LOWER(CONCAT(tr.video_title, ' ', tr.channel, ' ', tr.video_id, ' ', ta.action, ' ', ta.actor_name)) LIKE ${term}
    ORDER BY ta.created_at DESC
    LIMIT 300
  `;
  return rows.map((row) => ({
    ...runRow(row),
    action: {
      actionId: row.action_id,
      action: row.action,
      actorName: row.actor_name,
      note: row.note || "",
      retestConfirmed: Boolean(row.retest_confirmed),
      createdAt: row.action_created_at
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

export async function completeTestRun({ testRunId, action, actorName, note, retestConfirmed }) {
  await ensureSchema();
  const sql = getSql();
  const actionId = crypto.randomUUID();
  await sql`
    INSERT INTO test_actions (
      action_id,
      test_run_id,
      action,
      actor_name,
      note,
      retest_confirmed,
      metadata
    )
    VALUES (
      ${actionId},
      ${testRunId},
      ${action},
      ${actorName || "Reviewer"},
      ${note || ""},
      ${Boolean(retestConfirmed)},
      ${toJson({ source: "detector_modal" })}::jsonb
    )
  `;
  return getTestRun(testRunId);
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
      tr.youtube_channel_title,
      tr.youtube_channel_thumbnail_url,
      tr.thumbnail_previews,
      tr.updated_at
    FROM test_runs tr
    WHERE tr.status NOT IN ('sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
      AND NOT EXISTS (
        SELECT 1 FROM test_actions ta WHERE ta.test_run_id = tr.test_run_id
      )
    ORDER BY LOWER(tr.channel), tr.updated_at DESC
    LIMIT 1000
  `;
  return rows.map(runRow);
}

export async function recordConnectorEvents({ events = [], actorName = "", connectorId = "", source = "studio_bell" } = {}) {
  await ensureSchema();
  const activeRuns = await listConnectorActiveRuns();
  const results = [];
  for (const item of events) {
    const event = parseStudioNotification({ ...item, source: item.source || source });
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
    const match = matchFinishEventToRun(event, activeRuns);
    const row = await insertFinishEvent({
      event: {
        ...event,
        connectorId
      },
      testRunId: match.run?.testRunId || "",
      matchedConfidence: match.matchedConfidence,
      processingStatus: match.run ? "matched" : "unmatched",
      actorName
    });
    results.push({
      eventId: row?.event_id || "",
      testRunId: match.run?.testRunId || "",
      videoId: event.videoId,
      processingStatus: match.run ? "matched" : "unmatched",
      matchedConfidence: match.matchedConfidence,
      detectedOutcome: event.detectedOutcome
    });
  }
  return results;
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
    LIMIT 50
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
    SELECT event_id, video_id, channel, source, raw_text, notification_url, detected_outcome, actor_name, observed_at, created_at
    FROM finish_events
    WHERE processing_status = 'unmatched'
      AND (
        raw_text ILIKE '%test & compare%'
        OR raw_text ILIKE '%test and compare%'
        OR raw_text ILIKE '%a/b%'
        OR raw_text ILIKE '%ab test%'
        OR raw_text ILIKE '%thumbnail test%'
        OR raw_text ILIKE '%title test%'
        OR raw_text ILIKE '%not enough impressions%'
        OR raw_text ILIKE '%no clear%'
      )
      AND raw_text NOT ILIKE '%set a thumbnail that stands out%'
      AND raw_text NOT ILIKE '%made for kids%'
      AND raw_text NOT ILIKE '%coppa%'
      AND raw_text NOT ILIKE '%personalized ads and notifications%'
      AND raw_text NOT ILIKE '%a/b test running%'
      AND raw_text NOT ILIKE '%ab test running%'
      AND raw_text NOT ILIKE '%test running%'
      AND raw_text NOT ILIKE '%running… get suggestions%'
      AND LOWER(TRIM(raw_text)) NOT IN (
        'a/b test completed',
        'ab test completed',
        'thumbnail test ready',
        'thumbnail test ready set test',
        'title test ready',
        'title test ready set test'
      )
    ORDER BY observed_at DESC
    LIMIT 50
  `;
  return rows.map((row) => ({
    eventId: row.event_id,
    videoId: row.video_id,
    channel: row.channel,
    source: row.source,
    rawText: row.raw_text,
    notificationUrl: row.notification_url,
    detectedOutcome: row.detected_outcome,
    actorName: row.actor_name,
    observedAt: row.observed_at,
    createdAt: row.created_at
  }));
}

async function insertFinishEvent({ event, testRunId, matchedConfidence, processingStatus, actorName }) {
  const sql = getSql();
  const hash = finishEventHash({ ...event, testRunId });
  const eventId = `fe_${hash.slice(0, 24)}`;
  const rows = await sql`
    INSERT INTO finish_events (
      event_id,
      event_hash,
      test_run_id,
      video_id,
      channel,
      source,
      raw_text,
      notification_url,
      matched_confidence,
      detected_outcome,
      processing_status,
      actor_name,
      payload,
      observed_at,
      updated_at
    )
    VALUES (
      ${eventId},
      ${hash},
      ${testRunId || event.testRunId || ""},
      ${event.videoId || ""},
      ${event.channel || ""},
      ${event.source || "studio_bell"},
      ${event.rawText || ""},
      ${event.url || ""},
      ${matchedConfidence || ""},
      ${event.detectedOutcome || ""},
      ${processingStatus || "unmatched"},
      ${actorName || ""},
      ${toJson(event)}::jsonb,
      ${event.observedAt || new Date().toISOString()},
      NOW()
    )
    ON CONFLICT (event_hash)
    DO UPDATE SET
      test_run_id = CASE
        WHEN finish_events.test_run_id = '' AND EXCLUDED.test_run_id <> '' THEN EXCLUDED.test_run_id
        ELSE finish_events.test_run_id
      END,
      matched_confidence = CASE
        WHEN finish_events.matched_confidence = '' AND EXCLUDED.matched_confidence <> '' THEN EXCLUDED.matched_confidence
        ELSE finish_events.matched_confidence
      END,
      processing_status = CASE
        WHEN finish_events.processing_status = 'unmatched' AND EXCLUDED.processing_status = 'matched' THEN 'matched'
        ELSE finish_events.processing_status
      END,
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING *
  `;
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
    possibleRetest: 0
  };
  for (const run of runs) {
    if (run.queueStatus === "sheet_changed_after_done") summary.sheetChangedAfterDone += 1;
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
      const key = normalizeMatchText(channel);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing || new Date(item.lastSeenAt) > new Date(existing.lastSeenAt)) {
        map.set(key, item);
      }
    }
  }
  return map;
}

function applyConnectorCoverage(run, coverage) {
  const covered = coverage.get(normalizeMatchText(run.channel));
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
  const queueStatus =
    drifted && hasAction
      ? "sheet_changed_after_done"
      : baseQueueStatus === "running" && isPastFourteenDays(row.start_date)
        ? "past_due_check"
        : baseQueueStatus;
  return {
    testRunId: row.test_run_id,
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
    startDate: dateOnly(row.start_date),
    finishDate: dateOnly(row.finish_date),
    effectiveFinishDate: dateOnly(row.effective_finish_date),
    overdueDays: row.overdue_days,
    status: row.status,
    queueStatus,
    detectedOutcome: row.detected_outcome,
    suggestedWinner: row.suggested_winner,
    winnerReason: row.winner_reason,
    options: fromJson(row.options, {}),
    watchTimeShare: fromJson(row.watch_time_share, {}),
    troubles: fromJson(row.troubles, []),
    thumbnailPreviews: fromJson(row.thumbnail_previews, {}),
    currentYoutubeTitle: row.current_youtube_title,
    currentYoutubeThumbnailUrl: row.current_youtube_thumbnail_url,
    youtubeChannelTitle: row.youtube_channel_title,
    youtubeChannelThumbnailUrl: row.youtube_channel_thumbnail_url || "",
    possibleRetest: Boolean(row.possible_retest),
    driftedAt: row.drifted_at,
    driftReason: row.drift_reason,
    latestAction: row.latest_action || "",
    latestActor: row.latest_actor || "",
    latestActionAt: row.latest_action_at || "",
    finishEventId: row.finish_event_id || "",
    finishEventSource,
    finishEventText: row.finish_event_text || "",
    finishEventUrl: row.finish_event_url || "",
    finishEventOutcome: row.finish_event_outcome || "",
    finishEventAt: row.finish_event_at || "",
    matchedConfidence: row.matched_confidence || "",
    connectorCovered: false,
    connectorLastSeenAt: "",
    connectorActorName: ""
  };
}

function isValidQueueFinishEvent(row) {
  const source = row.finish_event_source || "";
  if (!source) return false;
  if (source === "metadata") return true;
  const outcome = row.finish_event_outcome || "";
  if (!outcome || outcome === "unknown") return false;
  return isLikelyFinishNotification(row.finish_event_text || "");
}

function isPastFourteenDays(value) {
  const start = dateOnly(value);
  if (!start) return false;
  const startDate = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(startDate.valueOf())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.floor((today - startDate) / 86400000) >= 14;
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

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isRecent(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return false;
  return Date.now() - date.valueOf() < 3 * 60 * 60 * 1000;
}
