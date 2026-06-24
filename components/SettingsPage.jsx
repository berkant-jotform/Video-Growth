"use client";

import { useEffect, useState } from "react";
import { Clipboard, ExternalLink, Save, ShieldCheck } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const DELETE_SECRET_VALUE = "__DELETE_SECRET__";

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
    title: "Studio Connector",
    note: "Chrome extension settings. Use the same connector token in the extension. Channels are comma-separated and define coverage priorities.",
    fields: [
      ["CONNECTOR_TOKEN", "Connector token", "input", true],
      ["CONNECTOR_CHANNELS", "Monitored channels", "textarea"]
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
    key: "connectorToken",
    label: "Studio Connector Token",
    required: true,
    fix: "Create a random token here, save it, then paste the same token into the Chrome extension."
  },
  {
    key: "connectorChannels",
    label: "Connector Channels",
    required: true,
    fix: "Keep Jotform, AI Agents Podcast, and AI Agents first. Add other channel names as needed."
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
  const connectorToken = form.CONNECTOR_TOKEN || "";
  const connectorChannels = form.CONNECTOR_CHANNELS || "Jotform, AI Agents Podcast, AI Agents";

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

        <InstallExtensionPanel
          connectorToken={connectorToken}
          connectorChannels={connectorChannels}
          onGenerateToken={() =>
            setForm((current) => ({ ...current, CONNECTOR_TOKEN: generateConnectorToken() }))
          }
        />

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

        <section className="settings-panel readiness-panel">
          <p className="eyebrow">Connector Coverage</p>
          <h2>Last extension heartbeat</h2>
          <div className="readiness-list">
            {config?.connectorStatus?.length ? (
              config.connectorStatus.slice(0, 5).map((item) => (
                <div className="readiness-row detailed" key={item.connectorId}>
                  <div>
                    <span className="readiness-title">
                      <ShieldCheck size={16} />
                      {item.actorName || "Chrome extension"}
                      <em>{item.active ? "Active" : "Stale"}</em>
                    </span>
                    <p>{(item.channels || []).join(", ") || "No channels reported"}</p>
                    <code>{item.connectorId}</code>
                  </div>
                  <div className="readiness-meta">
                    <strong className={item.active ? "ok" : "missing"}>
                      {item.active ? "Watching" : "No recent heartbeat"}
                    </strong>
                    <span>{item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "Never"}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="readiness-row detailed">
                <div>
                  <span className="readiness-title">
                    <ShieldCheck size={16} />
                    No extension heartbeat yet
                    <em>Setup</em>
                  </span>
                  <p>Install the Chrome extension, paste the connector token, then send a heartbeat.</p>
                  <code>extension/options.html</code>
                </div>
                <div className="readiness-meta">
                  <strong className="missing">Missing</strong>
                  <span>Settings</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function InstallExtensionPanel({ connectorToken, connectorChannels, onGenerateToken }) {
  const appUrl = typeof window === "undefined" ? "https://video-growth.vercel.app" : window.location.origin;
  const visibleToken = connectorToken && connectorToken !== "********" ? connectorToken : "";
  const copyText = [
    `App URL: ${appUrl}`,
    `Connector token: ${visibleToken || "generate-or-enter-token-first"}`,
    `Channels: ${connectorChannels}`
  ].join("\n");

  return (
    <section className="settings-panel full-width install-panel">
      <p className="eyebrow">Install Chrome Extension</p>
      <h2>Studio bell finish detector</h2>
      <p className="muted">
        This extension is the real finish signal. It runs in the Chrome profile that is logged into
        YouTube Studio, reads visible Studio notification text, and reports matching finish events
        back to this app.
      </p>

      <div className="install-actions">
        <a
          className="primary-button"
          href="/downloads/youtube-ab-tests-connector.zip"
          download
        >
          <ExternalLink size={16} />
          Download Extension Zip
        </a>
        <button type="button" className="secondary-button" onClick={onGenerateToken}>
          Generate Connector Token
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => navigator.clipboard?.writeText(copyText)}
        >
          <Clipboard size={16} />
          Copy Extension Values
        </button>
      </div>

      <div className="install-grid">
        <div className="install-card">
          <h3>1. Prepare the extension folder</h3>
          <ol>
            <li>Download the zip above.</li>
            <li>Unzip it.</li>
            <li>Keep the unzipped folder somewhere easy to find.</li>
          </ol>
          <p>
            On this Mac, you can also use the local source folder:
            <code>/Users/berkantgul/Documents/B Tests/extension</code>
          </p>
        </div>
        <div className="install-card">
          <h3>2. Load it in Chrome</h3>
          <ol>
            <li>Open <code>chrome://extensions</code>.</li>
            <li>Turn on <strong>Developer Mode</strong>.</li>
            <li>Click <strong>Load unpacked</strong>.</li>
            <li>Select the unzipped extension folder.</li>
          </ol>
        </div>
        <div className="install-card">
          <h3>3. Configure the extension</h3>
          <dl className="copy-values">
            <div>
              <dt>App URL</dt>
              <dd>{appUrl}</dd>
            </div>
            <div>
              <dt>Connector token</dt>
              <dd>{visibleToken || "Generate or enter one below, then save."}</dd>
            </div>
            <div>
              <dt>Channels</dt>
              <dd>{connectorChannels}</dd>
            </div>
          </dl>
          <p>
            If the token shows <code>********</code> below, the saved secret is hidden. Generate a new
            token if you need to set up another browser.
          </p>
        </div>
        <div className="install-card">
          <h3>4. Confirm coverage</h3>
          <ol>
            <li>Open YouTube Studio in the same Chrome profile.</li>
            <li>Open the extension popup.</li>
            <li>Click <strong>Send heartbeat</strong>.</li>
            <li>Refresh this Settings page and check Connector Coverage.</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

function SettingField({ label, name, type, secret, source, value, onChange }) {
  const markedForRemoval = value === DELETE_SECRET_VALUE;
  const maskedSecret = secret && value === "********";
  return (
    <label className="setting-field">
      <span>
        {label}
        <em>{sourceLabel(source)}</em>
      </span>
      {markedForRemoval ? (
        <div className="secret-removal">
          <strong>Will be removed when you save.</strong>
          <button type="button" className="secondary-button" onClick={() => onChange("********")}>
            Undo
          </button>
        </div>
      ) : type === "textarea" ? (
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
      {maskedSecret && source === "app" ? (
        <button
          type="button"
          className="secondary-button remove-secret-button"
          onClick={() => onChange(DELETE_SECRET_VALUE)}
        >
          Remove saved value
        </button>
      ) : null}
      {maskedSecret && source === "env" ? (
        <p className="field-hint">This value comes from Vercel env. Remove it in Vercel, then redeploy.</p>
      ) : null}
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

function generateConnectorToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `ytab_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}
