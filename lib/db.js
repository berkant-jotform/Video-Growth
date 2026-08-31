import { neon } from "@neondatabase/serverless";

let client = null;
let schemaReady = false;
let schemaPromise = null;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getSql() {
  if (!process.env.DATABASE_URL) {
    const error = new Error("DATABASE_URL is not configured.");
    error.status = 503;
    throw error;
  }
  if (!client) client = neon(process.env.DATABASE_URL);
  return client;
}

export async function ensureSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = initializeSchema().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function initializeSchema() {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS scan_runs (
      scan_id TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      actor_name TEXT NOT NULL DEFAULT 'system'
    )
  `;
  await sql`ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`
    UPDATE scan_runs
    SET status = 'failed',
        completed_at = COALESCE(completed_at, NOW()),
        summary = jsonb_build_object('error', 'Scan was abandoned before completion.')
    WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '12 minutes'
  `;
  await sql`
    WITH duplicate_running AS (
      SELECT scan_id,
        ROW_NUMBER() OVER (ORDER BY started_at DESC) AS position
      FROM scan_runs
      WHERE status = 'running'
    )
    UPDATE scan_runs
    SET status = 'failed',
        completed_at = COALESCE(completed_at, NOW()),
        summary = jsonb_build_object('error', 'Superseded by another scan.')
    WHERE scan_id IN (SELECT scan_id FROM duplicate_running WHERE position > 1)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS scan_runs_single_running_idx
    ON scan_runs ((status))
    WHERE status = 'running'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_runs (
      test_run_id TEXT PRIMARY KEY,
      test_id TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      video_id TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL,
      source_tab_mode TEXT NOT NULL DEFAULT 'active',
      spreadsheet_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      test_type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      video_title TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      studio_url TEXT NOT NULL DEFAULT '',
      start_date DATE,
      finish_date DATE,
      effective_finish_date DATE,
      overdue_days INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      detected_outcome TEXT NOT NULL DEFAULT 'result_missing',
      suggested_winner TEXT NOT NULL DEFAULT '',
      winner_reason TEXT NOT NULL DEFAULT '',
      options JSONB NOT NULL DEFAULT '{}'::jsonb,
      watch_time_share JSONB NOT NULL DEFAULT '{}'::jsonb,
      troubles JSONB NOT NULL DEFAULT '[]'::jsonb,
      thumbnail_previews JSONB NOT NULL DEFAULT '{}'::jsonb,
      current_youtube_title TEXT NOT NULL DEFAULT '',
      current_youtube_thumbnail_url TEXT NOT NULL DEFAULT '',
      youtube_channel_id TEXT NOT NULL DEFAULT '',
      youtube_channel_title TEXT NOT NULL DEFAULT '',
      youtube_channel_thumbnail_url TEXT NOT NULL DEFAULT '',
      option_fingerprint TEXT NOT NULL DEFAULT '',
      row_fingerprint TEXT NOT NULL DEFAULT '',
      source_payload_hash TEXT NOT NULL DEFAULT '',
      source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_scan_id TEXT,
      possible_retest BOOLEAN NOT NULL DEFAULT FALSE,
      drifted_at TIMESTAMPTZ,
      drift_reason TEXT NOT NULL DEFAULT '',
      previous_source_payload_hash TEXT NOT NULL DEFAULT ''
    )
  `;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS test_id TEXT`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS source_tab_mode TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS external_tab_id TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE INDEX IF NOT EXISTS test_runs_source_tab_mode_idx
    ON test_runs (source_tab_mode, source_kind)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_runs_source_tab_identity_idx
    ON test_runs (source_kind, spreadsheet_id, external_tab_id)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS source_workbooks (
      source_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      parent_spreadsheet_id TEXT NOT NULL DEFAULT '',
      linked_from TEXT NOT NULL DEFAULT '',
      read_status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_scan_id TEXT NOT NULL DEFAULT '',
      last_read_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_kind, spreadsheet_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS source_tabs (
      source_tab_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      external_tab_id TEXT NOT NULL DEFAULT '',
      current_title TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'active',
      read_status TEXT NOT NULL DEFAULT 'unknown',
      recognized BOOLEAN NOT NULL DEFAULT FALSE,
      likely_test_data BOOLEAN NOT NULL DEFAULT FALSE,
      last_seen_scan_id TEXT NOT NULL DEFAULT '',
      last_read_at TIMESTAMPTZ,
      missing_since TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS source_tabs_workbook_idx
    ON source_tabs (source_kind, spreadsheet_id, read_status)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS channel_registry (
      channel_key TEXT PRIMARY KEY,
      youtube_channel_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 100,
      provisional BOOLEAN NOT NULL DEFAULT TRUE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_registry_youtube_id_idx
    ON channel_registry (youtube_channel_id)
    WHERE youtube_channel_id <> ''
  `;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS result_evidence TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS result_semantics_version TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS explicit_winner_variant TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS highest_share_variant TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS operational_decision TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS youtube_applied_variant TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS inconclusive_reason TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS inconclusive_reason_evidence TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE TABLE IF NOT EXISTS logical_tests (
      test_id TEXT PRIMARY KEY,
      primary_test_run_id TEXT NOT NULL DEFAULT '',
      video_id TEXT NOT NULL DEFAULT '',
      test_type TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
      data_quality_flag TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'unknown',
      result_evidence TEXT NOT NULL DEFAULT 'unknown',
      result_semantics_version TEXT NOT NULL DEFAULT '',
      explicit_winner_variant TEXT NOT NULL DEFAULT '',
      highest_share_variant TEXT NOT NULL DEFAULT '',
      operational_decision TEXT NOT NULL DEFAULT '',
      youtube_applied_variant TEXT NOT NULL DEFAULT '',
      inconclusive_reason TEXT NOT NULL DEFAULT '',
      inconclusive_reason_evidence TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS logical_tests_video_type_idx
    ON logical_tests (video_id, test_type)
    WHERE video_id <> ''
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS video_context (
      video_id TEXT PRIMARY KEY,
      published_at TIMESTAMPTZ,
      definition TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER,
      live_archive BOOLEAN NOT NULL DEFAULT FALSE,
      made_for_kids BOOLEAN,
      privacy_status TEXT NOT NULL DEFAULT '',
      context_fetched_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_identity_aliases (
      alias_id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL REFERENCES logical_tests(test_id) ON DELETE CASCADE,
      alias_type TEXT NOT NULL,
      alias_value TEXT NOT NULL UNIQUE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_identity_aliases_test_idx
    ON test_identity_aliases (test_id, active)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_source_links (
      test_run_id TEXT PRIMARY KEY REFERENCES test_runs(test_run_id) ON DELETE CASCADE,
      test_id TEXT NOT NULL REFERENCES logical_tests(test_id) ON DELETE CASCADE,
      linkage_method TEXT NOT NULL DEFAULT '',
      linkage_confidence TEXT NOT NULL DEFAULT '',
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_source_links_test_idx
    ON test_source_links (test_id)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_id_history (
      history_id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL REFERENCES logical_tests(test_id) ON DELETE CASCADE,
      test_run_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      old_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      new_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT NOT NULL DEFAULT '',
      migration_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_runs_video_idx
    ON test_runs (video_id)
    WHERE video_id <> ''
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_runs_active_video_type_idx
    ON test_runs (video_id, test_type, source_kind, status)
    WHERE video_id <> ''
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_runs_source_seen_idx
    ON test_runs (source_kind, last_seen_scan_id)
  `;
    await sql`
      ALTER TABLE test_runs
      ADD COLUMN IF NOT EXISTS youtube_channel_thumbnail_url TEXT NOT NULL DEFAULT ''
    `;
  await sql`
    ALTER TABLE test_runs
    ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT NOT NULL DEFAULT ''
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_actions (
      action_id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL REFERENCES test_runs(test_run_id) ON DELETE CASCADE,
      test_id TEXT,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      retest_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;
  await sql`ALTER TABLE test_actions ADD COLUMN IF NOT EXISTS test_id TEXT`;
  await sql`
    CREATE INDEX IF NOT EXISTS test_actions_run_idx
    ON test_actions (test_run_id)
  `;
  await sql`ALTER TABLE test_actions ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ`;
  await sql`ALTER TABLE test_actions ADD COLUMN IF NOT EXISTS undone_by TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE INDEX IF NOT EXISTS test_actions_active_run_idx
    ON test_actions (test_run_id, created_at DESC)
    WHERE undone_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS test_actions_active_test_idx
    ON test_actions (test_id, created_at DESC)
    WHERE undone_at IS NULL AND test_id IS NOT NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS thumbnail_previews (
      preview_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      option_key TEXT NOT NULL,
      url TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'image/png',
      upload_id TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_kind, sheet_name, row_number, option_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS uploads (
      upload_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS finish_events (
      event_id TEXT PRIMARY KEY,
      event_hash TEXT UNIQUE NOT NULL,
      test_run_id TEXT NOT NULL DEFAULT '',
      test_id TEXT,
      video_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      raw_text TEXT NOT NULL DEFAULT '',
      notification_url TEXT NOT NULL DEFAULT '',
      notification_age TEXT NOT NULL DEFAULT '',
      matched_confidence TEXT NOT NULL DEFAULT '',
      detected_outcome TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'unknown',
      result_evidence TEXT NOT NULL DEFAULT 'unknown',
      result_semantics_version TEXT NOT NULL DEFAULT '',
      explicit_winner_variant TEXT NOT NULL DEFAULT '',
      youtube_applied_variant TEXT NOT NULL DEFAULT '',
      inconclusive_reason TEXT NOT NULL DEFAULT '',
      inconclusive_reason_evidence TEXT NOT NULL DEFAULT '',
      processing_status TEXT NOT NULL DEFAULT 'unmatched',
      actor_name TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS test_id TEXT`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS result_evidence TEXT NOT NULL DEFAULT 'unknown'`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS result_semantics_version TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS explicit_winner_variant TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS youtube_applied_variant TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS inconclusive_reason TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE finish_events ADD COLUMN IF NOT EXISTS inconclusive_reason_evidence TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE TABLE IF NOT EXISTS result_migrations (
      migration_id TEXT PRIMARY KEY,
      semantics_version TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_checksum TEXT NOT NULL,
      pre_migration_checksum TEXT NOT NULL DEFAULT '',
      post_migration_checksum TEXT NOT NULL DEFAULT '',
      rollback_checksum TEXT NOT NULL DEFAULT '',
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_at TIMESTAMPTZ,
      rolled_back_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS result_migration_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL REFERENCES result_migrations(migration_id) ON DELETE CASCADE,
      snapshot_kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      checksum TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS result_migration_audit (
      audit_id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL REFERENCES result_migrations(migration_id) ON DELETE CASCADE,
      test_id TEXT NOT NULL,
      test_run_id TEXT NOT NULL DEFAULT '',
      field_name TEXT NOT NULL,
      old_value JSONB NOT NULL DEFAULT 'null'::jsonb,
      new_value JSONB NOT NULL DEFAULT 'null'::jsonb,
      evidence TEXT NOT NULL DEFAULT 'unknown',
      reason TEXT NOT NULL DEFAULT '',
      semantics_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS history_exports (
      export_id TEXT PRIMARY KEY,
      actor_name TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request JSONB NOT NULL,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      file_checksum TEXT NOT NULL DEFAULT '',
      blob_url TEXT NOT NULL DEFAULT '',
      blob_pathname TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS history_exports_recent_idx
    ON history_exports (created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_test_run_idx
    ON finish_events (test_run_id, observed_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_test_idx
    ON finish_events (test_id, observed_at DESC)
    WHERE test_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_processing_idx
    ON finish_events (processing_status, observed_at DESC)
  `;
    await sql`
      CREATE INDEX IF NOT EXISTS finish_events_video_idx
      ON finish_events (video_id, observed_at DESC)
    `;
  await sql`
    ALTER TABLE finish_events
    ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT ''
  `;
  await sql`
    ALTER TABLE finish_events
    ADD COLUMN IF NOT EXISTS notification_age TEXT NOT NULL DEFAULT ''
  `;
  await sql`
    ALTER TABLE finish_events
    ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_channel_id_idx
    ON finish_events (channel_id, observed_at DESC)
    WHERE channel_id <> ''
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS connector_heartbeats (
      connector_id TEXT PRIMARY KEY,
      actor_name TEXT NOT NULL DEFAULT '',
      channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'online',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS connector_tokens (
      token_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT 'Chrome',
      token_hash TEXT UNIQUE NOT NULL,
      token_prefix TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE connector_tokens ADD COLUMN IF NOT EXISTS connector_id TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE connector_tokens ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE connector_tokens ADD COLUMN IF NOT EXISTS last_version TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE TABLE IF NOT EXISTS connector_pairings (
      pairing_id TEXT PRIMARY KEY,
      code_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT 'Chrome',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ,
      connector_id TEXT NOT NULL DEFAULT '',
      token_id TEXT NOT NULL DEFAULT ''
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS connector_pairings_expiry_idx
    ON connector_pairings (expires_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS connector_scan_jobs (
      job_id TEXT PRIMARY KEY,
      requested_by TEXT NOT NULL DEFAULT '',
      target_connector_id TEXT NOT NULL DEFAULT '',
      claimed_by TEXT NOT NULL DEFAULT '',
      channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      test_type TEXT NOT NULL DEFAULT 'all',
      mode TEXT NOT NULL DEFAULT 'notifications',
      status TEXT NOT NULL DEFAULT 'queued',
      progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT NOT NULL DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE connector_scan_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE connector_scan_jobs ADD COLUMN IF NOT EXISTS last_lease_owner TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE INDEX IF NOT EXISTS connector_scan_jobs_queue_idx
    ON connector_scan_jobs (status, requested_at)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS connector_scan_jobs_connector_idx
    ON connector_scan_jobs (claimed_by, updated_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS notification_profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      email_recipients TEXT NOT NULL DEFAULT '',
      slack_webhook_url TEXT NOT NULL DEFAULT '',
      rules JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS review_resolutions (
      resolution_id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(target_type, target_id, action)
    )
  `;
  await sql`ALTER TABLE review_resolutions ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ`;
  await sql`ALTER TABLE review_resolutions ADD COLUMN IF NOT EXISTS undone_by TEXT NOT NULL DEFAULT ''`;
  await sql`
    CREATE INDEX IF NOT EXISTS review_resolutions_active_target_idx
    ON review_resolutions (target_type, target_id, action)
    WHERE undone_at IS NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS diagnostic_logs (
      log_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS diagnostic_logs_created_idx
    ON diagnostic_logs (created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS diagnostic_logs_category_idx
    ON diagnostic_logs (category, created_at DESC)
  `;
  schemaReady = true;
}

export function toJson(value) {
  return JSON.stringify(value ?? null);
}

export function fromJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
