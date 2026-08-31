import crypto from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db.js";

export async function createConnectorDeviceToken({
  label = "Chrome",
  actorName = "Reviewer",
  connectorId = "",
  capabilities = {},
  version = ""
} = {}) {
  await ensureSchema();
  const sql = getSql();
  const tokenId = crypto.randomUUID();
  const token = `ytab_${crypto.randomBytes(24).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 13);
  await sql`
    INSERT INTO connector_tokens (
      token_id,
      label,
      token_hash,
      token_prefix,
      created_by,
      connector_id,
      capabilities,
      last_version
    )
    VALUES (
      ${tokenId},
      ${String(label || "Chrome").trim().slice(0, 80) || "Chrome"},
      ${tokenHash},
      ${tokenPrefix},
      ${String(actorName || "Reviewer").trim().slice(0, 80) || "Reviewer"},
      ${String(connectorId || "").trim().slice(0, 100)},
      ${JSON.stringify(capabilities || {})}::jsonb,
      ${String(version || "").trim().slice(0, 40)}
    )
  `;
  return { tokenId, token, tokenPrefix };
}

export async function listConnectorDeviceTokens() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT token_id, label, token_prefix, created_by, connector_id, capabilities,
      last_version, created_at, last_used_at, revoked_at
    FROM connector_tokens
    ORDER BY revoked_at NULLS FIRST, last_used_at DESC NULLS LAST, created_at DESC
    LIMIT 100
  `;
  return rows.map((row) => ({
    tokenId: row.token_id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdBy: row.created_by,
    connectorId: row.connector_id || "",
    capabilities: row.capabilities || {},
    version: row.last_version || "",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    active: !row.revoked_at
  }));
}

export async function authenticateConnectorDeviceToken(token) {
  if (!token) return null;
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE connector_tokens
    SET last_used_at = NOW()
    WHERE token_hash = ${hashToken(token)}
      AND revoked_at IS NULL
    RETURNING token_id, label, token_prefix, created_by, connector_id, capabilities, last_version
  `;
  if (!rows[0]) return null;
  return {
    tokenId: rows[0].token_id,
    label: rows[0].label,
    tokenPrefix: rows[0].token_prefix,
    createdBy: rows[0].created_by,
    connectorId: rows[0].connector_id || "",
    capabilities: rows[0].capabilities || {},
    version: rows[0].last_version || ""
  };
}

export async function updateConnectorDeviceIdentity(tokenId, { connectorId = "", capabilities = {}, version = "" } = {}) {
  if (!tokenId) return null;
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE connector_tokens
    SET connector_id = CASE WHEN ${String(connectorId || "").trim()} <> '' THEN ${String(connectorId || "").trim().slice(0, 100)} ELSE connector_id END,
        capabilities = CASE WHEN ${JSON.stringify(capabilities || {})}::jsonb <> '{}'::jsonb THEN ${JSON.stringify(capabilities || {})}::jsonb ELSE capabilities END,
        last_version = CASE WHEN ${String(version || "").trim()} <> '' THEN ${String(version || "").trim().slice(0, 40)} ELSE last_version END,
        last_used_at = NOW()
    WHERE token_id = ${tokenId}
      AND revoked_at IS NULL
    RETURNING token_id, connector_id, capabilities, last_version
  `;
  return rows[0] || null;
}

export async function revokeConnectorDeviceToken(tokenId) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE connector_tokens
    SET revoked_at = NOW()
    WHERE token_id = ${tokenId}
      AND revoked_at IS NULL
    RETURNING token_id, connector_id
  `;
  const connectorId = String(rows[0]?.connector_id || "").trim();
  if (connectorId) {
    await sql`
      UPDATE connector_heartbeats
      SET status = 'offline', last_seen_at = NOW()
      WHERE connector_id = ${connectorId}
    `;
    await sql`
      UPDATE connector_scan_jobs
      SET status = CASE
            WHEN status = 'cancel_requested' THEN 'cancelled'
            WHEN attempt_count >= 3 THEN 'failed'
            ELSE 'queued'
          END,
          target_connector_id = '',
          last_lease_owner = CASE WHEN claimed_by <> '' THEN claimed_by ELSE last_lease_owner END,
          claimed_by = '',
          lease_expires_at = NULL,
          completed_at = CASE WHEN status = 'cancel_requested' OR attempt_count >= 3 THEN NOW() ELSE completed_at END,
          error = CASE WHEN attempt_count >= 3 THEN 'The assigned browser was disconnected after repeated attempts.' ELSE '' END,
          progress = progress || CASE
            WHEN status = 'cancel_requested' THEN '{"stage":"cancelled","message":"Check stopped because the browser was disconnected.","percent":100}'::jsonb
            WHEN attempt_count >= 3 THEN '{"stage":"failed","message":"The assigned browser was disconnected after repeated attempts.","percent":100}'::jsonb
            ELSE '{"stage":"queued","message":"Browser disconnected. Waiting for another connected browser.","percent":0}'::jsonb
          END,
          updated_at = NOW()
      WHERE status IN ('queued', 'claimed', 'running', 'cancel_requested')
        AND (target_connector_id = ${connectorId} OR claimed_by = ${connectorId})
    `;
  }
  return Boolean(rows[0]);
}

export async function hasActiveConnectorDeviceTokens() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1 FROM connector_tokens WHERE revoked_at IS NULL
    ) AS configured
  `;
  return Boolean(rows[0]?.configured);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}
