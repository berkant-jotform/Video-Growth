import { neon } from "@neondatabase/serverless";

let client = null;
let schemaReady = false;

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
    CREATE TABLE IF NOT EXISTS test_runs (
      test_run_id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL,
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
  await sql`
    ALTER TABLE test_runs
    ADD COLUMN IF NOT EXISTS youtube_channel_thumbnail_url TEXT NOT NULL DEFAULT ''
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS test_actions (
      action_id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL REFERENCES test_runs(test_run_id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      retest_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )
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
      video_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      raw_text TEXT NOT NULL DEFAULT '',
      notification_url TEXT NOT NULL DEFAULT '',
      matched_confidence TEXT NOT NULL DEFAULT '',
      detected_outcome TEXT NOT NULL DEFAULT '',
      processing_status TEXT NOT NULL DEFAULT 'unmatched',
      actor_name TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_test_run_idx
    ON finish_events (test_run_id, observed_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS finish_events_video_idx
    ON finish_events (video_id, observed_at DESC)
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
