import crypto from "node:crypto";
import { ensureSchema, fromJson, getSql } from "./db.js";
import { resolveEventOccurredAt } from "./finish-events.mjs";

export async function loadHistoryExportSource({ skipSchema = false } = {}) {
  if (!skipSchema) await ensureSchema();
  const sql = getSql();
  const [
    testRows,
    sourceRows,
    actionRows,
    signalRows,
    contextRows,
    scanRows,
    idRows,
    aliasRows
  ] = await Promise.all([
    sql`
      WITH base AS (
        SELECT
          lt.*,
          tr.video_title,
          tr.current_youtube_title,
          TO_CHAR(tr.start_date, 'YYYY-MM-DD') AS start_date,
          TO_CHAR(tr.finish_date, 'YYYY-MM-DD') AS finish_date,
          tr.options,
          tr.watch_time_share,
          tr.thumbnail_previews,
          tr.possible_retest,
          tr.drifted_at,
          tr.drift_reason,
          tr.studio_url,
          tr.channel,
          COALESCE(src.source_record_count, 0) AS source_record_count
        FROM logical_tests lt
        LEFT JOIN test_runs tr ON tr.test_run_id = lt.primary_test_run_id
        LEFT JOIN (
          SELECT test_id, COUNT(*)::int AS source_record_count
          FROM test_source_links
          GROUP BY test_id
        ) src ON src.test_id = lt.test_id
      ),
      sequenced AS (
        SELECT base.*,
          LAG(test_id) OVER (
            PARTITION BY video_id, test_type
            ORDER BY start_date NULLS LAST, created_at, test_id
          ) AS previous_test_id
        FROM base
      )
      SELECT *
      FROM sequenced
      ORDER BY test_id
    `,
    sql`
      SELECT
        tr.test_run_id, tr.test_id, tr.video_id, tr.source_kind,
        tr.spreadsheet_id, tr.sheet_name, tr.row_number, tr.status,
        TO_CHAR(tr.start_date, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(tr.finish_date, 'YYYY-MM-DD') AS finish_date,
        tr.option_fingerprint, tr.content_hash,
        tr.last_seen_scan_id, tr.updated_at
      FROM test_runs tr
      WHERE tr.test_id IS NOT NULL
      ORDER BY tr.test_id, tr.test_run_id
    `,
    sql`
      SELECT
        action_id, test_id, test_run_id, action, actor_name, note,
        created_at, undone_at, undone_by
      FROM test_actions
      WHERE test_id IS NOT NULL
      ORDER BY created_at, action_id
    `,
    sql`
      SELECT
        event_id, test_id, test_run_id, video_id, channel, source, raw_text,
        matched_confidence, processing_status, result, result_evidence,
        explicit_winner_variant, inconclusive_reason, notification_age,
        occurred_at, observed_at
      FROM finish_events
      WHERE test_id IS NOT NULL
      ORDER BY observed_at, event_id
    `,
    sql`
      SELECT
        video_id, published_at, definition, duration_seconds, live_archive,
        made_for_kids, privacy_status, context_fetched_at
      FROM video_context
      ORDER BY video_id
    `,
    sql`
      SELECT
        scan_id, status, actor_name, started_at, completed_at,
        warnings, summary, COALESCE(progress->'counts', '{}'::jsonb) AS counts
      FROM scan_runs
      ORDER BY started_at DESC
      LIMIT 500
    `,
    sql`
      SELECT
        history_id, test_id, test_run_id, event_type, old_value, new_value,
        reason, migration_id, created_at
      FROM test_id_history
      ORDER BY created_at, history_id
    `,
    sql`
      SELECT
        alias_id, test_id, alias_type, alias_value, active,
        first_seen_at, last_seen_at
      FROM test_identity_aliases
      ORDER BY test_id, alias_type, alias_value
    `
  ]);
  return {
    tests: testRows.map(mapTest),
    sourceRecords: sourceRows.map(mapSourceRecord),
    actions: actionRows.map(mapAction),
    finishSignals: signalRows.map(mapSignal),
    videoContexts: contextRows.map(mapVideoContext),
    scanHistory: scanRows.map(mapScan),
    idHistory: idRows.map(mapIdHistory),
    aliases: aliasRows.map(mapAlias)
  };
}

export async function upsertVideoContexts(contexts = []) {
  if (!contexts.length) return 0;
  await ensureSchema();
  const sql = getSql();
  const payload = JSON.stringify(
    contexts.map((item) => ({
      video_id: item.videoId,
      published_at: item.publishedAt || "",
      definition: item.definition || "",
      duration_seconds: Number.isFinite(item.durationSeconds)
        ? item.durationSeconds
        : null,
      live_archive: Boolean(item.liveArchive),
      made_for_kids:
        typeof item.madeForKids === "boolean" ? item.madeForKids : null,
      privacy_status: item.privacyStatus || "",
      context_fetched_at: item.contextFetchedAt || new Date().toISOString()
    }))
  );
  await sql`
    INSERT INTO video_context (
      video_id, published_at, definition, duration_seconds, live_archive,
      made_for_kids, privacy_status, context_fetched_at, updated_at
    )
    SELECT
      item.video_id,
      NULLIF(item.published_at, '')::timestamptz,
      item.definition,
      item.duration_seconds,
      item.live_archive,
      item.made_for_kids,
      item.privacy_status,
      item.context_fetched_at::timestamptz,
      NOW()
    FROM jsonb_to_recordset(${payload}::jsonb) AS item(
      video_id text,
      published_at text,
      definition text,
      duration_seconds integer,
      live_archive boolean,
      made_for_kids boolean,
      privacy_status text,
      context_fetched_at text
    )
    ON CONFLICT (video_id) DO UPDATE SET
      published_at = EXCLUDED.published_at,
      definition = EXCLUDED.definition,
      duration_seconds = EXCLUDED.duration_seconds,
      live_archive = EXCLUDED.live_archive,
      made_for_kids = EXCLUDED.made_for_kids,
      privacy_status = EXCLUDED.privacy_status,
      context_fetched_at = EXCLUDED.context_fetched_at,
      updated_at = NOW()
  `;
  return contexts.length;
}

export async function saveHistoryExport({
  exportId = crypto.randomUUID(),
  actorName,
  schemaVersion,
  requestHash,
  request,
  counts,
  fileName,
  contentType,
  fileSize,
  fileChecksum,
  blobUrl = "",
  blobPathname = "",
  storageWarning = ""
}) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO history_exports (
      export_id, actor_name, schema_version, request_hash, request, counts,
      file_name, content_type, file_size, file_checksum, blob_url,
      blob_pathname, status, error
    ) VALUES (
      ${exportId}, ${actorName}, ${schemaVersion}, ${requestHash},
      ${JSON.stringify(request)}::jsonb, ${JSON.stringify(counts)}::jsonb,
      ${fileName}, ${contentType}, ${fileSize}, ${fileChecksum},
      ${blobUrl}, ${blobPathname}, 'ready', ${storageWarning}
    )
  `;
  return exportId;
}

export async function listRecentHistoryExports(limit = 5) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM history_exports
    WHERE status = 'ready'
    ORDER BY created_at DESC
    LIMIT ${Math.min(20, Math.max(1, Number(limit) || 5))}
  `;
  return rows.map(mapExport);
}

export async function getHistoryExport(exportId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM history_exports
    WHERE export_id = ${exportId}
    LIMIT 1
  `;
  return rows[0] ? mapExport(rows[0]) : null;
}

function mapTest(row) {
  return {
    testId: row.test_id,
    primaryTestRunId: row.primary_test_run_id,
    videoId: row.video_id,
    testType: row.test_type,
    sourceKind: row.source_kind,
    channel: row.channel || "",
    videoTitle: row.video_title || "",
    currentYoutubeTitle: row.current_youtube_title || "",
    lifecycleStatus: row.lifecycle_status,
    dataQualityFlag: row.data_quality_flag,
    result: row.result,
    resultEvidence: row.result_evidence,
    resultSemanticsVersion: row.result_semantics_version,
    explicitWinnerVariant: row.explicit_winner_variant,
    highestShareVariant: row.highest_share_variant,
    operationalDecision: row.operational_decision,
    youtubeAppliedVariant: row.youtube_applied_variant,
    inconclusiveReason: row.inconclusive_reason,
    inconclusiveReasonEvidence: row.inconclusive_reason_evidence,
    contentHash: row.content_hash,
    startDate: row.start_date,
    finishDate: row.finish_date,
    options: fromJson(row.options, {}),
    watchTimeShare: fromJson(row.watch_time_share, {}),
    thumbnailPreviews: fromJson(row.thumbnail_previews, {}),
    possibleRetest: Boolean(row.possible_retest),
    previousTestId: row.previous_test_id || "",
    driftedAt: row.drifted_at,
    driftReason: row.drift_reason || "",
    studioUrl: row.studio_url || "",
    sourceRecordCount: Number(row.source_record_count || 0)
  };
}

function mapSourceRecord(row) {
  return {
    testRunId: row.test_run_id,
    testId: row.test_id,
    videoId: row.video_id,
    sourceKind: row.source_kind,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    rowNumber: row.row_number,
    status: row.status,
    startDate: row.start_date,
    finishDate: row.finish_date,
    optionFingerprint: row.option_fingerprint,
    contentHash: row.content_hash,
    lastSeenScanId: row.last_seen_scan_id,
    updatedAt: row.updated_at
  };
}

function mapAction(row) {
  return {
    actionId: row.action_id,
    testId: row.test_id,
    testRunId: row.test_run_id,
    action: row.action,
    actorName: row.actor_name,
    note: row.note,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    undoneBy: row.undone_by
  };
}

function mapSignal(row) {
  return {
    eventId: row.event_id,
    testId: row.test_id,
    testRunId: row.test_run_id,
    videoId: row.video_id,
    channel: row.channel,
    source: row.source,
    rawText: row.raw_text,
    matchedConfidence: row.matched_confidence,
    processingStatus: row.processing_status,
    result: row.result,
    resultEvidence: row.result_evidence,
    explicitWinnerVariant: row.explicit_winner_variant,
    inconclusiveReason: row.inconclusive_reason,
    occurredAt: resolveEventOccurredAt({
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      notificationAge: row.notification_age
    }),
    observedAt: row.observed_at
  };
}

function mapVideoContext(row) {
  return {
    videoId: row.video_id,
    publishedAt: row.published_at,
    definition: row.definition,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    liveArchive: Boolean(row.live_archive),
    madeForKids: typeof row.made_for_kids === "boolean" ? row.made_for_kids : null,
    privacyStatus: row.privacy_status,
    contextFetchedAt: row.context_fetched_at
  };
}

function mapScan(row) {
  return {
    scanId: row.scan_id,
    status: row.status,
    actorName: row.actor_name,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    warnings: fromJson(row.warnings, []),
    summary: fromJson(row.summary, {}),
    counts: fromJson(row.counts, {})
  };
}

function mapIdHistory(row) {
  return {
    historyId: row.history_id,
    testId: row.test_id,
    testRunId: row.test_run_id,
    eventType: row.event_type,
    oldValue: fromJson(row.old_value, {}),
    newValue: fromJson(row.new_value, {}),
    reason: row.reason,
    migrationId: row.migration_id,
    createdAt: row.created_at
  };
}

function mapAlias(row) {
  return {
    aliasId: row.alias_id,
    testId: row.test_id,
    aliasType: row.alias_type,
    aliasValue: row.alias_value,
    active: Boolean(row.active),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function mapExport(row) {
  return {
    exportId: row.export_id,
    actorName: row.actor_name,
    schemaVersion: row.schema_version,
    requestHash: row.request_hash,
    request: fromJson(row.request, {}),
    counts: fromJson(row.counts, {}),
    fileName: row.file_name,
    contentType: row.content_type,
    fileSize: Number(row.file_size || 0),
    fileChecksum: row.file_checksum,
    blobUrl: row.blob_url,
    blobPathname: row.blob_pathname,
    status: row.status,
    storageWarning: row.error || "",
    createdAt: row.created_at,
    downloadAvailable: Boolean(row.blobUrl || row.blobPathname)
  };
}
