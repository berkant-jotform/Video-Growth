import { databaseConfigured, ensureSchema, getSql } from "@/lib/db.js";
import { extractSpreadsheetId } from "@/lib/domain.mjs";

const EDITABLE_KEYS = new Set([
  "TITLE_SPREADSHEET_ID",
  "THUMBNAIL_SPREADSHEET_ID",
  "DAILY_DIGEST_TIME_LOCAL",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "YOUTUBE_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "SLACK_WEBHOOK_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "DIGEST_EMAIL_RECIPIENTS"
]);

const SECRET_KEYS = new Set([
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_FILE",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "YOUTUBE_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "SLACK_WEBHOOK_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "DIGEST_EMAIL_RECIPIENTS",
  "CRON_SECRET"
]);

const PUBLIC_VALUE_KEYS = new Set([
  "TITLE_SPREADSHEET_ID",
  "THUMBNAIL_SPREADSHEET_ID",
  "DAILY_DIGEST_TIME_LOCAL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_FROM",
  "DIGEST_EMAIL_RECIPIENTS"
]);

export async function getAppConfig() {
  let stored = {};
  if (databaseConfigured()) {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`SELECT key, value FROM app_settings`;
    stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
  const settings = buildSettings(stored);
  return {
    settings,
    sources: Object.fromEntries(
      Object.entries(settings).map(([key, item]) => [key, item.source])
    ),
    titleSpreadsheetId: extractSpreadsheetId(settings.TITLE_SPREADSHEET_ID.value),
    thumbnailSpreadsheetId: extractSpreadsheetId(settings.THUMBNAIL_SPREADSHEET_ID.value),
    dailyDigestTimeLocal: settings.DAILY_DIGEST_TIME_LOCAL.value || "09:00",
    googleServiceAccountJson: settings.GOOGLE_SERVICE_ACCOUNT_JSON.value,
    googleServiceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "",
    googleOauthAccessToken: settings.GOOGLE_OAUTH_ACCESS_TOKEN.value,
    youtubeApiKey: settings.YOUTUBE_API_KEY.value,
    blobReadWriteToken: settings.BLOB_READ_WRITE_TOKEN.value,
    slackWebhookUrl: settings.SLACK_WEBHOOK_URL.value,
    smtpHost: settings.SMTP_HOST.value,
    smtpPort: settings.SMTP_PORT.value || "587",
    smtpUsername: settings.SMTP_USERNAME.value,
    smtpPassword: settings.SMTP_PASSWORD.value,
    smtpFrom: settings.SMTP_FROM.value,
    digestEmailRecipients: settings.DIGEST_EMAIL_RECIPIENTS.value
  };
}

export async function saveAppConfig(updates) {
  await ensureSchema();
  const sql = getSql();
  const normalized = {};
  for (const [key, rawValue] of Object.entries(updates || {})) {
    if (!EDITABLE_KEYS.has(key)) continue;
    if (SECRET_KEYS.has(key) && String(rawValue || "") === "********") continue;
    const value = key.endsWith("SPREADSHEET_ID")
      ? extractSpreadsheetId(rawValue)
      : String(rawValue || "").trim();
    validateSetting(key, value);
    normalized[key] = value;
    if (SECRET_KEYS.has(key) && !value) {
      await sql`DELETE FROM app_settings WHERE key = ${key}`;
    } else {
      await sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${key}, ${value}, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }
  }
  return normalized;
}

export function publicConfig(config) {
  return {
    titleSpreadsheetId: config.titleSpreadsheetId,
    thumbnailSpreadsheetId: config.thumbnailSpreadsheetId,
    dailyDigestTimeLocal: config.dailyDigestTimeLocal,
    configured: {
      database: Boolean(process.env.DATABASE_URL),
      sharedPassword: Boolean(process.env.APP_SHARED_PASSWORD_HASH),
      sessionSecret: Boolean(process.env.SESSION_SECRET),
      titleSpreadsheet: Boolean(config.titleSpreadsheetId),
      thumbnailSpreadsheet: Boolean(config.thumbnailSpreadsheetId),
      googleServiceAccount: Boolean(config.googleServiceAccountJson || config.googleServiceAccountFile),
      googleOauthFallback: Boolean(config.googleOauthAccessToken),
      youtubeApi: Boolean(config.youtubeApiKey),
      blob: Boolean(config.blobReadWriteToken),
      slack: Boolean(config.slackWebhookUrl),
      smtp: Boolean(config.smtpHost && config.smtpUsername && config.smtpPassword),
      digestEmail: Boolean(config.digestEmailRecipients)
    },
    values: publicValues(config.settings),
    sources: config.sources,
    secretKeys: Array.from(SECRET_KEYS)
  };
}

function buildSettings(stored) {
  const keys = [
    "TITLE_SPREADSHEET_ID",
    "THUMBNAIL_SPREADSHEET_ID",
    "DAILY_DIGEST_TIME_LOCAL",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
    "YOUTUBE_API_KEY",
    "BLOB_READ_WRITE_TOKEN",
    "SLACK_WEBHOOK_URL",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "DIGEST_EMAIL_RECIPIENTS"
  ];
  return Object.fromEntries(
    keys.map((key) => {
      if (Object.prototype.hasOwnProperty.call(stored, key)) {
        return [key, { value: stored[key], source: "app" }];
      }
      if (process.env[key]) {
        return [key, { value: process.env[key], source: "env" }];
      }
      if (key === "DAILY_DIGEST_TIME_LOCAL") {
        return [key, { value: "09:00", source: "default" }];
      }
      if (key === "SMTP_PORT") {
        return [key, { value: "587", source: "default" }];
      }
      return [key, { value: "", source: "missing" }];
    })
  );
}

function publicValues(settings) {
  return Object.fromEntries(
    Object.entries(settings).map(([key, item]) => {
      if (PUBLIC_VALUE_KEYS.has(key)) return [key, item.value || ""];
      return [key, item.value ? "********" : ""];
    })
  );
}

function validateSetting(key, value) {
  if (key === "GOOGLE_SERVICE_ACCOUNT_JSON" && value) {
    try {
      const parsed = JSON.parse(value);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error("Service account JSON must include client_email and private_key.");
      }
    } catch (error) {
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${error.message}`);
    }
  }
  if (key === "SMTP_PORT" && value && !Number.isInteger(Number(value))) {
    throw new Error("SMTP_PORT must be a number.");
  }
  if (key === "SLACK_WEBHOOK_URL" && value && !value.startsWith("https://")) {
    throw new Error("SLACK_WEBHOOK_URL must start with https://.");
  }
}
