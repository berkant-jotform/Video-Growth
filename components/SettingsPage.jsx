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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load settings.");
      setConfig(payload.config);
      setForm(payload.config.values || {});
    } catch (loadError) {
      setError(loadError.message || "Could not load settings.");
    }
  }

  async function save(event) {
    event?.preventDefault?.();
    setMessage("");
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save settings.");
      setConfig(payload.config);
      setForm(payload.config.values || {});
      setMessage("Settings saved.");
    } catch (saveError) {
      setError(saveError.message || "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  const databaseReady = Boolean(config?.configured?.database);
  const connectorStatus = config?.connectorStatus || [];

  return (
    <AppShell session={session} active="settings">
      <main className="workspace settings-grid">
        <section className="settings-panel full-width setup-overview">
          <p className="eyebrow">Guided setup</p>
          <h2>Set up the detector in order</h2>
          <div className="setup-steps">
            <SetupStep
              number="1"
              title="Data Sources"
              text="Connect the title and thumbnail sheets that the detector reads."
              state={config?.configured?.titleSpreadsheet && config?.configured?.thumbnailSpreadsheet ? "Ready" : "Setup needed"}
              tone={config?.configured?.titleSpreadsheet && config?.configured?.thumbnailSpreadsheet ? "ok" : "warn"}
            />
            <SetupStep
              number="2"
              title="YouTube / Extension"
              text="Add the YouTube API key and keep Studio watchers open."
              state={watchingStudioCount(connectorStatus) > 0 ? `Watching ${watchingStudioCount(connectorStatus)}` : "Open Studio watcher"}
              tone={watchingStudioCount(connectorStatus) > 0 ? "ok" : "warn"}
            />
            <SetupStep
              number="3"
              title="Notifications"
              text="Create personal email/browser notification profiles for the team."
              state={config?.configured?.smtp || config?.configured?.digestEmail ? "Configured" : "Optional"}
              tone={config?.configured?.smtp || config?.configured?.digestEmail ? "ok" : "neutral"}
            />
            <SetupStep
              number="4"
              title="Advanced / Admin"
              text="Database, Vercel env, Blob storage, and raw debug details."
              state={databaseReady ? "Online" : "Setup needed"}
              tone={databaseReady ? "ok" : "warn"}
            />
          </div>
        </section>

        <form onSubmit={save} className="settings-guide full-width">
          <section className="settings-panel guided-settings-section">
            <p className="eyebrow">1. Data Sources</p>
            <h2>Read the A/B test sheets</h2>
            <p className="muted">These are read-only sources. The app does not write to Sheets.</p>
            <fieldset className="settings-fieldset" disabled={!databaseReady}>
              <legend>Sheets</legend>
              {["TITLE_SPREADSHEET_ID", "THUMBNAIL_SPREADSHEET_ID"].map((key) => (
                <SettingField
                  key={key}
                  label={key === "TITLE_SPREADSHEET_ID" ? "Title spreadsheet ID or URL" : "Thumbnail spreadsheet ID or URL"}
                  name={key}
                  type="input"
                  source={config?.sources?.[key]}
                  value={form[key] || ""}
                  onChange={(value) => setForm((current) => ({ ...current, [key]: value }))}
                />
              ))}
            </fieldset>
            <details className="settings-fieldset optional-settings">
              <summary>
                <span>
                  <strong>Google private access fallback</strong>
                  <em>Only needed if public read access is blocked</em>
                </span>
              </summary>
              <div className="optional-settings-grid">
                {["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_OAUTH_ACCESS_TOKEN"].map((key) => (
                  <SettingField
                    key={key}
                    label={key === "GOOGLE_SERVICE_ACCOUNT_JSON" ? "Service account JSON" : "OAuth fallback token"}
                    name={key}
                    type={key === "GOOGLE_SERVICE_ACCOUNT_JSON" ? "textarea" : "input"}
                    secret
                    source={config?.sources?.[key]}
                    value={form[key] || ""}
                    onChange={(value) => setForm((current) => ({ ...current, [key]: value }))}
                  />
                ))}
              </div>
            </details>
            <SectionReadiness keys={["titleSpreadsheet", "thumbnailSpreadsheet"]} config={config} />
          </section>

          <section className="settings-panel guided-settings-section full-width">
            <p className="eyebrow">2. YouTube / Extension</p>
            <h2>Connect YouTube and keep Studio watched</h2>
            <p className="muted">
              YouTube API enriches cards. The Chrome extension is the real finish signal when Studio tabs are open.
            </p>
            <div className="settings-two-column">
              <fieldset className="settings-fieldset" disabled={!databaseReady}>
                <legend>YouTube metadata</legend>
                <SettingField
                  label="YouTube API key"
                  name="YOUTUBE_API_KEY"
                  type="input"
                  secret
                  source={config?.sources?.YOUTUBE_API_KEY}
                  value={form.YOUTUBE_API_KEY || ""}
                  onChange={(value) => setForm((current) => ({ ...current, YOUTUBE_API_KEY: value }))}
                />
              </fieldset>
              <ExtensionCoverageSummary connectorStatus={connectorStatus} />
            </div>
            <div className="notification-guidance">
              <span>Browser connections, watched channels, channel IDs, and detection rules are managed in one place.</span>
            </div>
            <a className="primary-button save-inline-button" href="/extension">
              <ExternalLink size={16} />
              Open Extension Setup
            </a>
            <SectionReadiness keys={["youtubeApi"]} config={config} />
          </section>

          <section className="settings-panel guided-settings-section">
            <p className="eyebrow">3. Notifications</p>
            <h2>Team notification profiles</h2>
            <p className="muted">
              Email, browser, and future Slack rules live in the Notifications tab so each person can have their own filters.
            </p>
            <div className="notification-guidance">
              <span>{config?.configured?.smtp ? "Email sender configured" : "Email sender setup needed for email digests"}</span>
              <span>{config?.configured?.digestEmail ? "Fallback digest recipients configured" : "Profiles can still use their own recipients"}</span>
            </div>
            <a className="primary-button save-inline-button" href="/notifications">
              <ExternalLink size={16} />
              Open Notifications
            </a>
          </section>

          <details className="settings-panel guided-settings-section advanced-settings">
            <summary>
              <span>
                <strong>4. Advanced / Admin</strong>
                <em>Database, Vercel env, Blob storage, and debug details</em>
              </span>
            </summary>
            <fieldset className="settings-fieldset" disabled={!databaseReady}>
              <legend>Thumbnail storage</legend>
              <SettingField
                label="Vercel Blob token"
                name="BLOB_READ_WRITE_TOKEN"
                type="input"
                secret
                source={config?.sources?.BLOB_READ_WRITE_TOKEN}
                value={form.BLOB_READ_WRITE_TOKEN || ""}
                onChange={(value) => setForm((current) => ({ ...current, BLOB_READ_WRITE_TOKEN: value }))}
              />
            </fieldset>
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
            <details className="readiness-optional">
              <summary>Raw extension checks</summary>
              <ExtensionDebugList connectorStatus={connectorStatus} />
            </details>
            <pre className="env-template">{ENV_TEMPLATE}</pre>
            <div className="setup-actions">
              <button
                className="secondary-button"
                type="button"
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
          </details>

          {error ? <p className="form-error">{error}</p> : null}
          {message ? <p className="form-success">{message}</p> : null}
          <button className="primary-button save-inline-button" disabled={!databaseReady || busy}>
            <Save size={17} />
            {busy ? "Saving..." : "Save Settings"}
          </button>
        </form>
      </main>
    </AppShell>
  );
}

function SectionReadiness({ keys, config }) {
  const items = READINESS_ITEMS.filter((item) => keys.includes(item.key));
  return (
    <div className="section-readiness">
      {items.map((item) => (
        <span className={config?.configured?.[item.key] ? "ok" : "missing"} key={item.key}>
          {config?.configured?.[item.key] ? "Ready" : "Setup needed"} · {item.label}
        </span>
      ))}
    </div>
  );
}

function ExtensionCoverageSummary({ connectorStatus }) {
  const active = connectorStatus.filter((item) => item.active);
  const watching = active.filter((item) => connectorOpenStudioTabs(item) > 0);
  return (
    <aside className="extension-summary-card">
      <h3>Extension status</h3>
      {active.length ? (
        <>
          <strong className={watching.length ? "ok" : "missing"}>
            {watching.length ? "Extension connected" : "Open Studio tab needed"}
          </strong>
          <p>
            {watching.length
              ? `${watchingStudioCount(watching)} Studio watcher${watchingStudioCount(watching) === 1 ? "" : "s"} open.`
              : "The extension checked in, but no Studio watcher was open."}
          </p>
          <span>Last checked {formatDateTime(active[0].lastSeenAt)}</span>
        </>
      ) : (
        <>
          <strong className="missing">Extension not connected</strong>
          <p>Install the extension, save the token, then open Studio watchers.</p>
          <span>Last checked never</span>
        </>
      )}
    </aside>
  );
}

function ExtensionDebugList({ connectorStatus }) {
  if (!connectorStatus.length) {
    return <p className="muted">No extension checks have been received yet.</p>;
  }
  return (
    <div className="readiness-list">
      {connectorStatus.slice(0, 5).map((item) => (
        <div className="readiness-row detailed" key={item.connectorId}>
          <div>
            <span className="readiness-title">
              <ShieldCheck size={16} />
              {item.actorName || "Chrome extension"}
              <em>{extensionCoverageState(item)}</em>
            </span>
            <p>{(item.channels || []).join(", ") || "No channels reported"}</p>
            <p className={connectorOpenStudioTabs(item) > 0 ? "coverage-ok" : "coverage-warning"}>
              {connectorOpenStudioTabs(item) > 0
                ? `${connectorOpenStudioTabs(item)} Studio watcher${connectorOpenStudioTabs(item) === 1 ? "" : "s"} open when last checked.`
                : "Extension checked in, but no Studio watcher was open."}
            </p>
            <code>{item.connectorId}</code>
          </div>
          <div className="readiness-meta">
            <strong className={item.active && connectorOpenStudioTabs(item) > 0 ? "ok" : "missing"}>
              {item.active && connectorOpenStudioTabs(item) > 0 ? "Watching" : item.active ? "Open tab needed" : "Stale"}
            </strong>
            <span>{item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "Never"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SetupStep({ number, title, text, state, tone = "neutral" }) {
  return (
    <article className={`setup-step ${tone}`}>
      <strong>{number}</strong>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      <span>{state}</span>
    </article>
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

function connectorOpenStudioTabs(item) {
  return Number(item?.payload?.openStudioTabs || 0);
}

function extensionCoverageState(item) {
  if (!item.active) return "Stale";
  return connectorOpenStudioTabs(item) > 0 ? "Watching" : "Open tab needed";
}

function watchingStudioCount(statuses) {
  return statuses.reduce((sum, item) => sum + connectorOpenStudioTabs(item), 0);
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}
