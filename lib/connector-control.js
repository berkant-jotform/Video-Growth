import crypto from "node:crypto";
import { ensureSchema, fromJson, getSql, toJson } from "@/lib/db.js";
import { CONNECTOR_JOB_MAX_ATTEMPTS } from "@/lib/connector-job-state.mjs";

export const CONNECTOR_JOB_TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
export const CONNECTOR_JOB_ACTIVE_STATUSES = new Set(["queued", "claimed", "running", "cancel_requested"]);
export const PAIRING_TTL_MINUTES = 10;
const JOB_LEASE_MINUTES = 3;
const JOB_MAX_QUEUE_MINUTES = 30;
const TARGET_FALLBACK_MINUTES = 2;

export async function createConnectorPairing({ label = "Chrome", actorName = "Reviewer" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const pairingId = crypto.randomUUID();
  const code = `ytab_pair_${crypto.randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO connector_pairings (pairing_id, code_hash, label, created_by, expires_at)
    VALUES (
      ${pairingId},
      ${hashSecret(code)},
      ${cleanText(label, 80) || "Chrome"},
      ${cleanText(actorName, 80) || "Reviewer"},
      NOW() + (${PAIRING_TTL_MINUTES} * INTERVAL '1 minute')
    )
  `;
  return {
    pairingId,
    code,
    label: cleanText(label, 80) || "Chrome",
    expiresAt: new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000).toISOString()
  };
}

export async function pairingStatus(pairingId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT pairing_id, label, created_by, created_at, expires_at, claimed_at, connector_id, token_id
    FROM connector_pairings
    WHERE pairing_id = ${cleanText(pairingId, 100)}
    LIMIT 1
  `;
  return rows[0] ? mapPairing(rows[0]) : null;
}

export async function claimConnectorPairing({
  code,
  connectorId,
  deviceLabel = "Chrome",
  version = "",
  capabilities = {}
} = {}) {
  await ensureSchema();
  const sql = getSql();
  const tokenId = crypto.randomUUID();
  const token = `ytab_${crypto.randomBytes(24).toString("base64url")}`;
  const safeConnectorId = cleanText(connectorId, 100) || crypto.randomUUID();
  const safeCapabilities = sanitizeCapabilities(capabilities);
  const rows = await sql`
    WITH claimed AS (
      UPDATE connector_pairings
      SET claimed_at = NOW(),
          connector_id = ${safeConnectorId},
          token_id = ${tokenId}
      WHERE code_hash = ${hashSecret(code)}
        AND claimed_at IS NULL
        AND expires_at > NOW()
      RETURNING label, created_by
    )
    INSERT INTO connector_tokens (
      token_id, label, token_hash, token_prefix, created_by,
      connector_id, capabilities, last_version
    )
    SELECT
      ${tokenId},
      COALESCE(NULLIF(${cleanText(deviceLabel, 80)}, ''), label),
      ${hashSecret(token)},
      ${token.slice(0, 13)},
      created_by,
      ${safeConnectorId},
      ${toJson(safeCapabilities)}::jsonb,
      ${cleanText(version, 40)}
    FROM claimed
    RETURNING token_id, label, token_prefix, connector_id, capabilities, last_version
  `;
  if (!rows[0]) return null;
  return {
    tokenId: rows[0].token_id,
    token,
    tokenPrefix: rows[0].token_prefix,
    label: rows[0].label,
    connectorId: rows[0].connector_id,
    capabilities: fromJson(rows[0].capabilities, {}),
    version: rows[0].last_version
  };
}

export async function createConnectorScanJob({
  actorName = "Reviewer",
  targetConnectorId = "",
  channels = [],
  testType = "all",
  mode = "notifications"
} = {}) {
  await ensureSchema();
  const sql = getSql();
  const jobId = crypto.randomUUID();
  const normalizedChannels = normalizeChannels(channels);
  const normalizedType = normalizeTestType(testType);
  const normalizedMode = normalizeJobMode(mode);
  await sql`
    INSERT INTO connector_scan_jobs (
      job_id, requested_by, target_connector_id, channels, test_type, mode, status, progress
    ) VALUES (
      ${jobId},
      ${cleanText(actorName, 80) || "Reviewer"},
      ${cleanText(targetConnectorId, 100)},
      ${toJson(normalizedChannels)}::jsonb,
      ${normalizedType},
      ${normalizedMode},
      'queued',
      ${toJson({ stage: "queued", message: "Waiting for a connected browser.", percent: 0, updatedAt: new Date().toISOString() })}::jsonb
    )
  `;
  return getConnectorScanJob(jobId);
}

export async function listConnectorScanJobs({ limit = 20 } = {}) {
  await ensureSchema();
  const sql = getSql();
  await expireStaleConnectorScanJobs(sql);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await sql`
    SELECT * FROM connector_scan_jobs
    ORDER BY requested_at DESC
    LIMIT ${safeLimit}
  `;
  return rows.map(mapJob);
}

export async function getConnectorScanJob(jobId) {
  await ensureSchema();
  const sql = getSql();
  await expireStaleConnectorScanJobs(sql);
  const rows = await sql`
    SELECT * FROM connector_scan_jobs
    WHERE job_id = ${cleanText(jobId, 100)}
    LIMIT 1
  `;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function claimConnectorScanJob({ connectorId, requestedJobId = "" } = {}) {
  await ensureSchema();
  const sql = getSql();
  const safeConnectorId = cleanText(connectorId, 100);
  if (!safeConnectorId) return null;
  await expireStaleConnectorScanJobs(sql);
  const requested = cleanText(requestedJobId, 100);
  const rows = await sql`
    WITH candidate AS (
      SELECT job_id
      FROM connector_scan_jobs
      WHERE (
          status = 'queued'
          OR (status IN ('claimed', 'running') AND lease_expires_at < NOW())
          OR (${requested} <> '' AND job_id = ${requested} AND claimed_by = ${safeConnectorId} AND status IN ('claimed', 'running'))
        )
        AND (
          target_connector_id = ''
          OR target_connector_id = ${safeConnectorId}
          OR (status = 'queued' AND requested_at < NOW() - (${TARGET_FALLBACK_MINUTES} * INTERVAL '1 minute'))
        )
        AND (${requested} = '' OR job_id = ${requested})
      ORDER BY CASE WHEN job_id = ${requested} THEN 0 ELSE 1 END, requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE connector_scan_jobs job
    SET claimed_by = ${safeConnectorId},
        last_lease_owner = CASE WHEN claimed_by <> '' THEN claimed_by ELSE last_lease_owner END,
        status = 'claimed',
        attempt_count = attempt_count + 1,
        claimed_at = COALESCE(claimed_at, NOW()),
        lease_expires_at = NOW() + (${JOB_LEASE_MINUTES} * INTERVAL '1 minute'),
        progress = progress || ${toJson({ stage: "claimed", message: "Connected browser accepted the check.", percent: 2, updatedAt: new Date().toISOString() })}::jsonb,
        updated_at = NOW()
    FROM candidate
    WHERE job.job_id = candidate.job_id
    RETURNING job.*
  `;
  return rows[0] ? mapJob(rows[0]) : null;
}

async function expireStaleConnectorScanJobs(sql) {
  await sql`
    UPDATE connector_scan_jobs
    SET status = 'cancelled',
        error = '',
        progress = progress || ${toJson({ stage: "cancelled", message: "Check stopped after the browser disconnected.", percent: 100 })}::jsonb,
        completed_at = NOW(),
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE status = 'cancel_requested'
      AND (lease_expires_at < NOW() OR (lease_expires_at IS NULL AND updated_at < NOW() - (${JOB_LEASE_MINUTES} * INTERVAL '1 minute')))
  `;
  await sql`
    UPDATE connector_scan_jobs
    SET status = 'queued',
        target_connector_id = '',
        last_lease_owner = claimed_by,
        claimed_by = '',
        lease_expires_at = NULL,
        error = '',
        progress = progress || ${toJson({ stage: "queued", message: "Browser disconnected. Retrying with another connected browser.", percent: 0 })}::jsonb,
        updated_at = NOW()
    WHERE status IN ('claimed', 'running')
      AND lease_expires_at < NOW()
      AND attempt_count < ${CONNECTOR_JOB_MAX_ATTEMPTS}
  `;
  await sql`
    UPDATE connector_scan_jobs
    SET status = 'failed',
        last_lease_owner = claimed_by,
        error = 'Connected browsers repeatedly disconnected before this check completed.',
        progress = progress || ${toJson({ stage: "failed", message: "Connected browsers repeatedly disconnected before this check completed.", percent: 100 })}::jsonb,
        completed_at = NOW(),
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE status IN ('claimed', 'running')
      AND lease_expires_at < NOW()
      AND attempt_count >= ${CONNECTOR_JOB_MAX_ATTEMPTS}
  `;
  await sql`
    UPDATE connector_scan_jobs
    SET status = 'failed',
        error = 'No connected browser claimed this check in time.',
        progress = progress || ${toJson({ stage: "failed", message: "No connected browser claimed this check in time.", percent: 100 })}::jsonb,
        completed_at = NOW(),
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE status = 'queued'
      AND (
        (attempt_count = 0 AND requested_at < NOW() - (${JOB_MAX_QUEUE_MINUTES} * INTERVAL '1 minute'))
        OR (attempt_count > 0 AND updated_at < NOW() - (${JOB_MAX_QUEUE_MINUTES} * INTERVAL '1 minute'))
      )
  `;
  await sql`
    DELETE FROM connector_scan_jobs
    WHERE status IN ('completed', 'partial', 'failed', 'cancelled')
      AND completed_at < NOW() - INTERVAL '30 days'
  `;
  await sql`
    DELETE FROM connector_pairings
    WHERE expires_at < NOW() - INTERVAL '7 days'
  `;
}

export async function updateConnectorScanJob(jobId, connectorId, update = {}) {
  await ensureSchema();
  const sql = getSql();
  const current = await getConnectorScanJob(jobId);
  if (!current || current.claimedBy !== cleanText(connectorId, 100)) return null;
  if (CONNECTOR_JOB_TERMINAL_STATUSES.has(current.status)) return current;
  const requestedStatus = normalizeJobUpdateStatus(update.status, current.status);
  const cancelled = current.cancelRequestedAt || requestedStatus === "cancelled";
  const status = cancelled ? "cancelled" : requestedStatus;
  const terminal = CONNECTOR_JOB_TERMINAL_STATUSES.has(status);
  const progress = sanitizeJobPayload(update.progress, 12_000);
  const result = sanitizeJobPayload(update.result, 40_000);
  const error = cleanText(update.error, 1000);
  const rows = await sql`
    UPDATE connector_scan_jobs
    SET status = ${status},
        progress = CASE WHEN ${toJson(progress)}::jsonb = '{}'::jsonb THEN progress ELSE ${toJson(progress)}::jsonb END,
        result = CASE WHEN ${toJson(result)}::jsonb = '{}'::jsonb THEN result ELSE ${toJson(result)}::jsonb END,
        error = CASE WHEN ${error} = '' THEN error ELSE ${error} END,
        started_at = CASE WHEN ${status} = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
        completed_at = CASE WHEN ${terminal} THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
        lease_expires_at = CASE WHEN ${terminal} THEN NULL ELSE NOW() + (${JOB_LEASE_MINUTES} * INTERVAL '1 minute') END,
        updated_at = NOW()
    WHERE job_id = ${cleanText(jobId, 100)}
      AND claimed_by = ${cleanText(connectorId, 100)}
      AND (status <> 'cancel_requested' OR ${status} = 'cancelled')
    RETURNING *
  `;
  if (rows[0]) return mapJob(rows[0]);
  const latest = await getConnectorScanJob(jobId);
  if (latest?.status === "cancel_requested" && status !== "cancelled") {
    return updateConnectorScanJob(jobId, connectorId, { ...update, status: "cancelled" });
  }
  return latest && CONNECTOR_JOB_TERMINAL_STATUSES.has(latest.status) ? latest : null;
}

export async function requestConnectorScanJobCancellation(jobId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE connector_scan_jobs
    SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
        cancel_requested_at = NOW(),
        completed_at = CASE WHEN status = 'queued' THEN NOW() ELSE completed_at END,
        progress = progress || ${toJson({ stage: "cancel_requested", message: "Stopping safely after the current channel.", updatedAt: new Date().toISOString() })}::jsonb,
        updated_at = NOW()
    WHERE job_id = ${cleanText(jobId, 100)}
      AND status IN ('queued', 'claimed', 'running')
    RETURNING *
  `;
  if (rows[0]) return mapJob(rows[0]);
  return getConnectorScanJob(jobId);
}

export function sanitizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key))
      .slice(0, 30)
      .map(([key, item]) => [key, typeof item === "boolean" || typeof item === "number" ? item : cleanText(item, 100)])
  );
}

function mapPairing(row) {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  return {
    pairingId: row.pairing_id,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    connectorId: row.connector_id,
    tokenId: row.token_id,
    status: row.claimed_at ? "connected" : expired ? "expired" : "waiting"
  };
}

function mapJob(row) {
  return {
    jobId: row.job_id,
    requestedBy: row.requested_by,
    targetConnectorId: row.target_connector_id,
    claimedBy: row.claimed_by,
    channels: fromJson(row.channels, []),
    testType: row.test_type,
    mode: row.mode,
    status: row.status,
    progress: fromJson(row.progress, {}),
    result: fromJson(row.result, {}),
    error: row.error,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelRequestedAt: row.cancel_requested_at,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: Number(row.attempt_count || 0),
    lastLeaseOwner: row.last_lease_owner || "",
    updatedAt: row.updated_at
  };
}

function normalizeChannels(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return Array.from(new Set(input.map((item) => cleanText(item, 120)).filter(Boolean))).slice(0, 30);
}

function normalizeTestType(value) {
  return ["title", "thumbnail"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "all";
}

function normalizeJobMode(value) {
  return ["notifications", "deep", "connection_test"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "notifications";
}

function normalizeJobUpdateStatus(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  return ["claimed", "running", "completed", "partial", "failed", "cancelled"].includes(normalized)
    ? normalized
    : fallback;
}

function sanitizeJobPayload(value, maxLength) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const text = JSON.stringify(value);
    if (text.length > maxLength) return { truncated: true, message: "Job details exceeded the storage limit." };
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
