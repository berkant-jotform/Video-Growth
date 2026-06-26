import { randomUUID } from "node:crypto";
import { ensureSchema, fromJson, getSql, toJson } from "@/lib/db.js";

export async function listNotificationProfiles() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT profile_id, display_name, enabled, email_recipients, slack_webhook_url, rules, created_at, updated_at
    FROM notification_profiles
    ORDER BY display_name ASC, created_at ASC
  `;
  return rows.map(profileRow);
}

export async function saveNotificationProfiles(profiles = []) {
  await ensureSchema();
  const sql = getSql();
  const normalized = profiles.map(normalizeProfile);
  await sql`DELETE FROM notification_profiles`;

  for (const profile of normalized) {
    await sql`
      INSERT INTO notification_profiles (
        profile_id,
        display_name,
        enabled,
        email_recipients,
        slack_webhook_url,
        rules,
        updated_at
      )
      VALUES (
        ${profile.profileId},
        ${profile.displayName},
        ${profile.enabled},
        ${profile.emailRecipients},
        ${profile.slackWebhookUrl},
        ${toJson(profile.rules)},
        NOW()
      )
      ON CONFLICT (profile_id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        email_recipients = EXCLUDED.email_recipients,
        slack_webhook_url = EXCLUDED.slack_webhook_url,
        rules = EXCLUDED.rules,
        updated_at = NOW()
    `;
  }
  return listNotificationProfiles();
}

function profileRow(row) {
  return {
    profileId: row.profile_id,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    emailRecipients: row.email_recipients,
    slackWebhookUrl: row.slack_webhook_url,
    rules: fromJson(row.rules, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeProfile(profile = {}) {
  return {
    profileId: String(profile.profileId || randomUUID()),
    displayName: String(profile.displayName || "").trim() || "Reviewer",
    enabled: profile.enabled !== false,
    emailRecipients: String(profile.emailRecipients || "").trim(),
    slackWebhookUrl: String(profile.slackWebhookUrl || "").trim(),
    rules: normalizeRules(profile.rules || {})
  };
}

function normalizeRules(rules = {}) {
  return {
    channels: normalizeList(rules.channels),
    testTypes: normalizeList(rules.testTypes),
    statuses: normalizeList(rules.statuses)
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
