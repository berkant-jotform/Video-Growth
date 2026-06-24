"use client";

import { useEffect, useState } from "react";
import { Clipboard, ExternalLink, Save, ShieldCheck } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const BOOTSTRAP_ITEMS = [
  {
    key: "database",
    label: "Database",
    env: "DATABASE_URL",
    required: true,
    fix: "Install Neon Postgres in Vercel Marketplace. Vercel will add DATABASE_URL. Locally, paste DATABASE_URL into .env.local and restart the app."
  },
  {
    key: "sharedPassword",
    label: "Shared Password Gate",
    env: "APP_SHARED_PASSWORD_HASH",
    required: false,
    fix: "Optional. Set this only if you want a shared password. Without it, reviewers enter initials only."
  },
  {
    key: "sessionSecret",
    label: "Session Secret",
    env: "SESSION_SECRET",
    required: true,
    fix: "Use a long random string. In Vercel, add it as SESSION_SECRET; locally, add it to .env.local and restart."
  }
];

const SETTING_GROUPS = [
  {
    title: "Sheet Sources",
    note: "Paste spreadsheet URLs or IDs. These are read-only sources.",
    fields: [
      ["TITLE_SPREADSHEET_ID", "Title spreadsheet ID or URL", "input"],
      ["THUMBNAIL_SPREADSHEET_ID", "Thumbnail spreadsheet ID or URL", "input"],
      ["DAILY_DIGEST_TIME_LOCAL", "Digest time", "input"]
    ]
  },
  {
    title: "Google Read-Only Access",
    note: "Optional. Preferred private path: service account JSON. If Google Cloud access is blocked, leave this blank and share each cloned sheet as Anyone with the link: Viewer so the XLSX export fallback can read it.",
    fields: [
      ["GOOGLE_SERVICE_ACCOUNT_JSON", "Service account JSON", "textarea", true],
      ["GOOGLE_OAUTH_ACCESS_TOKEN", "OAuth fallback token", "input", true]
    ]
  },
  {
    title: "YouTube And Thumbnail Previews",
    note: "YouTube API is read-only enrichment. Blob is only for hosted thumbnail preview uploads.",
    fields: [
      ["YOUTUBE_API_KEY", "YouTube API key", "input", true],
      ["BLOB_READ_WRITE_TOKEN", "Vercel Blob token", "input", true]
    ]
  },
  {
    title: "Slack Digest",
    note: "Optional. Paste an incoming Slack webhook URL.",
    fields: [["SLACK_WEBHOOK_URL", "Slack webhook URL", "input", true]]
  },
  {
    title: "Email Digest",
    note: "Optional SMTP sender settings for email digests.",
    fields: [
      ["SMTP_HOST", "SMTP host", "input"],
      ["SMTP_PORT", "SMTP port", "input"],
      ["SMTP_USERNAME", "SMTP username", "input"],
      ["SMTP_PASSWORD", "SMTP password", "input", true],
      ["SMTP_FROM", "From email", "input"],
      ["DIGEST_EMAIL_RECIPIENTS", "Digest recipients", "input"]
    ]
  }
];

const READINESS_ITEMS = [
  {
    key: "titleSpreadsheet",
    label: "Title Sheet",
    required: true,
    fix: "Add it in Sheet Sources below."
  },
  {
    key: "thumbnailSpreadsheet",
    label: "Thumbnail Sheet",
    required: true,
    fix: "Add it in Sheet Sources below."
  },
  {
    key: "googleServiceAccount",
    label: "Google Service Account",
    required: false,
    fix: "Optional. If blocked, remove this value and share each cloned sheet as Anyone with the link: Viewer."
  },
  {
    key: "googleOauthFallback",
    label: "Google OAuth Fallback",
    required: false,
    fix: "Only use this if service account access is blocked."
  },
  {
    key: "youtubeApi",
    label: "YouTube API",
    required: true,
    fix: "Paste a YouTube Data API key below."
  },
  {
    key: "blob",
    label: "Thumbnail Image Storage",
    required: false,
    fix: "Paste BLOB_READ_WRITE_TOKEN below if hosted thumbnail previews are needed."
  },
  {
    key: "slack",
    label: "Slack Digest",
    required: false,
    fix: "Paste Slack webhook URL below."
  },
  {
    key: "smtp",
    label: "SMTP Email",
    required: false,
    fix: "Fill SMTP host, username, and password below."
  },
  {
    key: "digestEmail",
    label: "Digest Recipients",
    required: false,
    fix: "Add comma-separated recipient emails below."
  }
];

const ENV_TEMPLATE = `SESSION_SECRET=
DATABASE_URL=

# Optional shared password gate:
APP_SHARED_PASSWORD_HASH=`;

export default function SettingsPage({ session }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const response = await fetch("/api/config");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not load settings.");
      return;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
  }

  async function save(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not save settings.");
      return;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
    setMessage("Settings saved.");
  }

  const databaseReady = Boolean(config?.configured?.database);

  return (
    <AppShell session={session} active="settings">
      <main className="workspace settings-grid">
        <section className="settings-panel full-width">
          <p className="eyebrow">Bootstrap</p>
          <h2>Cloud bootstrap and optional access gate</h2>
          <p className="muted">
            Database and session secret must exist before the app can store settings for the team.
            The shared password is optional; leave it empty for initials-only login.
          </p>
          <div className="readiness-list">
            {BOOTSTRAP_ITEMS.map((item) => (
              <SetupRow
                key={item.key}
                item={item}
                ready={Boolean(config?.configured?.[item.key])}
                location="Vercel env / .env.local"
              />
            ))}
          </div>
          <pre className="env-template">{ENV_TEMPLATE}</pre>
          <div className="setup-actions">
            <button
              className="secondary-button"
              onClick={() => navigator.clipboard?.writeText(ENV_TEMPLATE)}
            >
              <Clipboard size={16} />
              Copy Bootstrap Env Names
            </button>
            <a
              className="secondary-button"
              href="https://vercel.com/docs/environment-variables"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              Vercel Env Docs
            </a>
          </div>
        </section>

        <section className="settings-panel config-panel">
          <p className="eyebrow">Configuration</p>
          <h2>App-managed settings</h2>
          {databaseReady ? (
            <p className="muted">
              These values are saved in the app database. Existing env vars remain a fallback.
              For configured secrets, leave <code>********</code> unchanged unless replacing them;
              clear the field to remove a saved secret.
            </p>
          ) : (
            <p className="setup-warning">
              Configure <code>DATABASE_URL</code> first. Until then, the app can diagnose missing
              settings but cannot save changes here.
            </p>
          )}
          <form onSubmit={save} className="form-stack">
            {SETTING_GROUPS.map((group) => (
              <fieldset className="settings-fieldset" disabled={!databaseReady} key={group.title}>
                <legend>{group.title}</legend>
                <p>{group.note}</p>
                {group.fields.map(([key, label, type, secret]) => (
                  <SettingField
                    key={key}
                    label={label}
                    name={key}
                    type={type}
                    secret={Boolean(secret)}
                    source={config?.sources?.[key]}
                    value={form[key] || ""}
                    onChange={(value) => setForm((current) => ({ ...current, [key]: value }))}
                  />
                ))}
              </fieldset>
            ))}
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button" disabled={!databaseReady}>
              <Save size={17} />
              Save App Settings
            </button>
          </form>
        </section>

        <section className="settings-panel readiness-panel">
          <p className="eyebrow">Readiness</p>
          <h2>What still needs fixing</h2>
          <div className="readiness-list">
            {READINESS_ITEMS.map((item) => (
              <SetupRow
                key={item.key}
                item={item}
                ready={Boolean(config?.configured?.[item.key])}
                location="Settings form"
              />
            ))}
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function SettingField({ label, name, type, secret, source, value, onChange }) {
  return (
    <label className="setting-field">
      <span>
        {label}
        <em>{sourceLabel(source)}</em>
      </span>
      {type === "textarea" ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={value === "********" ? 3 : 8}
          spellCheck={false}
        />
      ) : (
        <input
          type={secret ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function SetupRow({ item, ready, location }) {
  return (
    <div className="readiness-row detailed">
      <div>
        <span className="readiness-title">
          <ShieldCheck size={16} />
          {item.label}
          <em>{item.required ? "Required" : "Optional"}</em>
        </span>
        <p>{item.fix}</p>
        <code>{item.env || "Configure in app"}</code>
      </div>
      <div className="readiness-meta">
        <strong className={ready ? "ok" : "missing"}>{ready ? "Configured" : "Missing"}</strong>
        <span>{location}</span>
      </div>
    </div>
  );
}

function sourceLabel(source) {
  if (source === "app") return "Saved in app";
  if (source === "env") return "From env";
  if (source === "default") return "Default";
  return "Missing";
}
