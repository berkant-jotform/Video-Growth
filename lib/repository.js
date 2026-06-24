import crypto from "node:crypto";
import { ensureSchema, fromJson, getSql, toJson } from "@/lib/db.js";

export async function createScanRun({ actorName }) {
  await ensureSchema();
  const sql = getSql();
  const scanId = crypto.randomUUID();
  await sql`
    INSERT INTO scan_runs (scan_id, started_at, status, actor_name)
    VALUES (${scanId}, NOW(), 'running', ${actorName || "system"})
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
        warnings = ${toJson(warnings || [])}::jsonb
    WHERE scan_id = ${scanId}
  `;
}

export async function lastScanRun() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT scan_id, started_at, completed_at, status, summary, warnings, actor_name
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
  const sql = getSql();
  const rows = await sql`
    SELECT source_kind, sheet_name, row_number, option_key, url
    FROM thumbnail_previews
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
    )
    SELECT tr.*, la.action AS latest_action, la.actor_name AS latest_actor, la.created_at AS latest_action_at
    FROM test_runs tr
    LEFT JOIN latest_action la ON la.test_run_id = tr.test_run_id
    WHERE (
      la.action IS NULL
      AND tr.status NOT IN ('running', 'sheet_marked_done', 'result_logged', 'winner_found', 'no_clear')
    )
    OR (
      la.action IS NOT NULL
      AND tr.drifted_at IS NOT NULL
    )
    ORDER BY LOWER(tr.channel), tr.effective_finish_date DESC NULLS LAST, tr.row_number
  `;
  return rows.map(runRow);
}

export async function listHistory({ search = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const term = `%${String(search || "").toLowerCase()}%`;
  const rows = await sql`
    SELECT tr.*, ta.action_id, ta.action, ta.actor_name, ta.note, ta.retest_confirmed, ta.created_at AS action_created_at
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
      ) AS actions
    FROM test_runs tr
    WHERE tr.test_run_id = ${testRunId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    ...runRow(rows[0]),
    actions: fromJson(rows[0].actions, [])
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
    needsReview: 0,
    missingData: 0,
    sheetChangedAfterDone: 0,
    possibleRetest: 0
  };
  for (const run of runs) {
    if (run.queueStatus === "sheet_changed_after_done") summary.sheetChangedAfterDone += 1;
    else if (run.status === "needs_review") {
      summary.needsReview += 1;
      summary.newlyFinished += 1;
    }
    else if (run.status === "missing_data") summary.missingData += 1;
    if (run.possibleRetest) summary.possibleRetest += 1;
  }
  return summary;
}

function runRow(row) {
  const drifted = Boolean(row.drifted_at);
  const hasAction = Boolean(row.latest_action || row.action);
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
    queueStatus: drifted && hasAction ? "sheet_changed_after_done" : row.status,
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
    possibleRetest: Boolean(row.possible_retest),
    driftedAt: row.drifted_at,
    driftReason: row.drift_reason,
    latestAction: row.latest_action || "",
    latestActor: row.latest_actor || "",
    latestActionAt: row.latest_action_at || ""
  };
}

function scanRow(row) {
  return {
    scanId: row.scan_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    summary: fromJson(row.summary, {}),
    warnings: fromJson(row.warnings, []),
    actorName: row.actor_name
  };
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
