import { databaseConfigured, ensureSchema, getSql } from "@/lib/db.js";
import { extractSpreadsheetId } from "@/lib/domain.mjs";
import {
  defaultConnectorChannels,
  defaultWatcherTabs,
  normalizeWatcherTab,
  parseConnectorChannels,
  parseWatcherTabs
} from "@/lib/finish-events.mjs";
import { LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";
import {
  EXTENSION_RUNTIME_CONFIG_KEY,
  defaultExtensionRuntimeConfigJson,
  parseExtensionRuntimeConfigJson,
  safeParseExtensionRuntimeConfigJson
} from "@/lib/extension-runtime-config.mjs";

const EDITABLE_KEYS = new Set([
  "TITLE_SPREADSHEET_ID",
  "THUMBNAIL_SPREADSHEET_ID",
  "DAILY_DIGEST_TIME_LOCAL",
  "NOTIFICATION_SLACK_CHANNELS",
  "NOTIFICATION_SLACK_TEST_TYPES",
  "NOTIFICATION_SLACK_STATUSES",
  "NOTIFICATION_EMAIL_CHANNELS",
  "NOTIFICATION_EMAIL_TEST_TYPES",
  "NOTIFICATION_EMAIL_STATUSES",
  "NOTIFICATION_BROWSER_CHANNELS",
  "NOTIFICATION_BROWSER_TEST_TYPES",
  "NOTIFICATION_BROWSER_STATUSES",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "YOUTUBE_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "CONNECTOR_TOKEN",
  "CONNECTOR_CHANNELS",
  "CONNECTOR_WATCHER_TABS",
  EXTENSION_RUNTIME_CONFIG_KEY,
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
  "CONNECTOR_TOKEN",
  "SLACK_WEBHOOK_URL",
  "SMTP_PASSWORD",
  "CRON_SECRET"
]);

const PUBLIC_VALUE_KEYS = new Set([
  "TITLE_SPREADSHEET_ID",
  "THUMBNAIL_SPREADSHEET_ID",
  "DAILY_DIGEST_TIME_LOCAL",
  "NOTIFICATION_SLACK_CHANNELS",
  "NOTIFICATION_SLACK_TEST_TYPES",
  "NOTIFICATION_SLACK_STATUSES",
  "NOTIFICATION_EMAIL_CHANNELS",
  "NOTIFICATION_EMAIL_TEST_TYPES",
  "NOTIFICATION_EMAIL_STATUSES",
  "NOTIFICATION_BROWSER_CHANNELS",
  "NOTIFICATION_BROWSER_TEST_TYPES",
  "NOTIFICATION_BROWSER_STATUSES",
  "CONNECTOR_CHANNELS",
  "CONNECTOR_WATCHER_TABS",
  EXTENSION_RUNTIME_CONFIG_KEY,
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_FROM",
  "DIGEST_EMAIL_RECIPIENTS"
]);

const DELETE_SECRET_VALUE = "__DELETE_SECRET__";

export async function getAppConfig() {
  let stored = {};
  if (databaseConfigured()) {
    await ensureSchema();
    const sql = getSql();
    const rows = await sql`SELECT key, value FROM app_settings`;
    stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
  const settings = buildSettings(stored);
  const extensionRuntime = safeParseExtensionRuntimeConfigJson(settings[EXTENSION_RUNTIME_CONFIG_KEY].value);
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
    connectorToken: settings.CONNECTOR_TOKEN.value,
    connectorChannels: parseConnectorChannels(settings.CONNECTOR_CHANNELS.value || defaultConnectorChannels()),
    connectorWatcherTabs: parseWatcherTabs(settings.CONNECTOR_WATCHER_TABS.value),
    extensionRuntimeConfig: extensionRuntime.config,
    extensionRuntimeConfigJson: JSON.stringify(extensionRuntime.config, null, 2),
    extensionRuntimeConfigError: extensionRuntime.error,
    slackWebhookUrl: settings.SLACK_WEBHOOK_URL.value,
    smtpHost: settings.SMTP_HOST.value,
    smtpPort: settings.SMTP_PORT.value || "587",
    smtpUsername: settings.SMTP_USERNAME.value,
    smtpPassword: settings.SMTP_PASSWORD.value,
    smtpFrom: settings.SMTP_FROM.value,
    digestEmailRecipients: settings.DIGEST_EMAIL_RECIPIENTS.value,
    notificationRules: {
      slack: notificationRule(settings, "SLACK"),
      email: notificationRule(settings, "EMAIL"),
      browser: notificationRule(settings, "BROWSER")
    }
  };
}

export async function saveAppConfig(updates) {
  await ensureSchema();
  const sql = getSql();
  const normalized = {};
  for (const [key, rawValue] of Object.entries(updates || {})) {
    if (!EDITABLE_KEYS.has(key)) continue;
    if (SECRET_KEYS.has(key) && rawValue === DELETE_SECRET_VALUE) {
      await sql`DELETE FROM app_settings WHERE key = ${key}`;
      normalized[key] = "";
      continue;
    }
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
      connectorToken: Boolean(config.connectorToken),
      connectorChannels: config.connectorChannels.length > 0,
      connectorWatcherTabs: config.connectorWatcherTabs.length > 0,
      cron: Boolean(process.env.CRON_SECRET),
      slack: Boolean(config.slackWebhookUrl),
      smtp: Boolean(config.smtpHost && config.smtpUsername && config.smtpPassword),
      digestEmail: Boolean(config.digestEmailRecipients)
    },
    notificationRules: config.notificationRules,
    extensionRuntimeConfigError: config.extensionRuntimeConfigError || "",
    latestExtensionVersion: LATEST_EXTENSION_VERSION,
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
    "NOTIFICATION_SLACK_CHANNELS",
    "NOTIFICATION_SLACK_TEST_TYPES",
    "NOTIFICATION_SLACK_STATUSES",
    "NOTIFICATION_EMAIL_CHANNELS",
    "NOTIFICATION_EMAIL_TEST_TYPES",
    "NOTIFICATION_EMAIL_STATUSES",
    "NOTIFICATION_BROWSER_CHANNELS",
    "NOTIFICATION_BROWSER_TEST_TYPES",
    "NOTIFICATION_BROWSER_STATUSES",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
    "YOUTUBE_API_KEY",
    "BLOB_READ_WRITE_TOKEN",
    "CONNECTOR_TOKEN",
    "CONNECTOR_CHANNELS",
    "CONNECTOR_WATCHER_TABS",
    EXTENSION_RUNTIME_CONFIG_KEY,
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
      if (key.startsWith("NOTIFICATION_")) {
        return [key, { value: "", source: "default" }];
      }
      if (key === "CONNECTOR_CHANNELS") {
        return [key, { value: defaultConnectorChannels(), source: "default" }];
      }
      if (key === "CONNECTOR_WATCHER_TABS") {
        return [key, { value: defaultWatcherTabs(), source: "default" }];
      }
      if (key === EXTENSION_RUNTIME_CONFIG_KEY) {
        return [key, { value: defaultExtensionRuntimeConfigJson(), source: "default" }];
      }
      return [key, { value: "", source: "missing" }];
    })
  );
}

function notificationRule(settings, method) {
  return {
    channels: parseList(settings[`NOTIFICATION_${method}_CHANNELS`]?.value),
    testTypes: parseList(settings[`NOTIFICATION_${method}_TEST_TYPES`]?.value),
    statuses: parseList(settings[`NOTIFICATION_${method}_STATUSES`]?.value)
  };
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  if (key === EXTENSION_RUNTIME_CONFIG_KEY) {
    parseExtensionRuntimeConfigJson(value);
  }
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
  if (key === "SMTP_PORT" && value && (Number(value) < 1 || Number(value) > 65535)) {
    throw new Error("SMTP_PORT must be between 1 and 65535.");
  }
  if (key === "DAILY_DIGEST_TIME_LOCAL" && value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error("Daily digest time must use 24-hour HH:MM format.");
  }
  if (key.endsWith("SPREADSHEET_ID") && value && !/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    throw new Error(`${key} is not a valid Google spreadsheet ID or URL.`);
  }
  if (key === "CONNECTOR_WATCHER_TABS" && value) {
    const lines = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
    const invalid = lines.find((line) => {
      const separatorIndex = line.search(/[|=]/);
      if (separatorIndex < 0) return !normalizeWatcherTab({ target: line }).url;
      const label = line.slice(0, separatorIndex).trim();
      const target = line.slice(separatorIndex + 1).trim();
      return !label || (target && !normalizeWatcherTab({ label, target }).url);
    });
    if (invalid) {
      throw new Error("Watcher rows must have a channel name and, when supplied, a valid Studio channel URL or UC channel ID.");
    }
  }
  if (key === "SLACK_WEBHOOK_URL" && value && !value.startsWith("https://")) {
    throw new Error("SLACK_WEBHOOK_URL must start with https://.");
  }
}
