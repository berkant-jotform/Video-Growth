"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCircle2, Clipboard, Database, ExternalLink, Save, Settings2, ShieldCheck, Undo2, Youtube } from "lucide-react";
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
  const [savedForm, setSavedForm] = useState({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  const hasChanges = useMemo(() => JSON.stringify(form) !== JSON.stringify(savedForm), [form, savedForm]);

  useEffect(() => {
    function protectUnsavedChanges(event) {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () => window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [hasChanges]);

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load settings.");
      const values = payload.config.values || {};
      setConfig(payload.config);
      setForm(values);
      setSavedForm(values);
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
      const values = payload.config.values || {};
      setConfig(payload.config);
      setForm(values);
      setSavedForm(values);
      setMessage("Settings saved. New scans will use these values.");
    } catch (saveError) {
      setError(saveError.message || "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  const databaseReady = Boolean(config?.configured?.database);
  const connectorStatus = config?.connectorStatus || [];
  const essentials = [
    Boolean(config?.configured?.titleSpreadsheet && config?.configured?.thumbnailSpreadsheet),
    Boolean(config?.configured?.youtubeApi),
    Boolean(connectorStatus.some((item) => item.active))
  ];
  const readyCount = essentials.filter(Boolean).length;

  function discardChanges() {
    setForm(savedForm);
    setError("");
    setMessage("Unsaved changes discarded.");
  }

  return (
    <AppShell session={session} active="settings">
      <main className="workspace settings-grid settings-workspace">
        <section className="settings-panel full-width settings-command-header">
          <div className="settings-command-copy">
            <p className="eyebrow">Workspace settings</p>
            <h2>Configure once, then scan from Detector</h2>
            <p className="muted">Everyday scanning stays on the Detector page. This page is only for data sources, YouTube access, and team setup.</p>
          </div>
          <div className="settings-readiness-meter" aria-label={`${readyCount} of 3 essential connections ready`}>
            <div>
              <span>Essential connections</span>
              <strong>{readyCount}/3 ready</strong>
            </div>
            <progress value={readyCount} max="3">{readyCount} of 3</progress>
            <small>{readyCount === 3 ? "Ready for reliable scans" : "Complete the highlighted section below"}</small>
          </div>
          <nav className="settings-section-nav" aria-label="Settings sections">
            <a href="#data-sources"><Database size={16} />Data sources</a>
            <a href="#youtube-extension"><Youtube size={16} />YouTube and extension</a>
            <a href="#notification-settings"><Bell size={16} />Notifications</a>
            <a href="#advanced-settings"><Settings2 size={16} />Advanced</a>
          </nav>
        </section>

        <form onSubmit={save} className="settings-guide full-width">
          {error ? <p className="form-error settings-feedback" role="alert">{error}</p> : null}
          {message ? <p className="form-success settings-feedback" role="status">{message}</p> : null}

          <section id="data-sources" className="settings-panel guided-settings-section settings-focus-section">
            <SettingsSectionHeading
              number="1"
              title="Data sources"
              description="The two read-only sheets used to build the test queue. The app never writes to either sheet."
              ready={Boolean(config?.configured?.titleSpreadsheet && config?.configured?.thumbnailSpreadsheet)}
            />
            <fieldset className="settings-fieldset" disabled={!databaseReady}>
              <legend>Google Sheets</legend>
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

          <section id="youtube-extension" className="settings-panel guided-settings-section full-width settings-focus-section">
            <SettingsSectionHeading
              number="2"
              title="YouTube and extension"
              description="The API supplies current video details. The Chrome extension supplies the real Studio finish signal."
              ready={Boolean(config?.configured?.youtubeApi && connectorStatus.some((item) => item.active))}
            />
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
            <div className="settings-next-action">
              <CheckCircle2 size={18} />
              <span>Browser connections, watched channels, and detection reliability are managed on the dedicated Extension page.</span>
            </div>
            <a className="primary-button save-inline-button" href="/extension">
              <ExternalLink size={16} />
              Open Extension Setup
            </a>
            <SectionReadiness keys={["youtubeApi"]} config={config} />
          </section>

          <section id="notification-settings" className="settings-panel guided-settings-section settings-focus-section">
            <SettingsSectionHeading
              number="3"
              title="Notifications"
              description="Each teammate can choose their own channels, test types, delivery method, and schedule."
              ready={Boolean(config?.configured?.smtp || config?.configured?.digestEmail)}
              optional
            />
            <div className="notification-guidance">
              <span>{config?.configured?.smtp ? "Email sender configured" : "Email sender setup needed for email digests"}</span>
              <span>{config?.configured?.digestEmail ? "Fallback digest recipients configured" : "Profiles can still use their own recipients"}</span>
            </div>
            <a className="primary-button save-inline-button" href="/notifications">
              <ExternalLink size={16} />
              Open Notifications
            </a>
          </section>

          <details id="advanced-settings" className="settings-panel guided-settings-section advanced-settings full-width">
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

          <footer className={`settings-save-bar ${hasChanges ? "dirty" : ""}`}>
            <div>
              <strong>{hasChanges ? "Unsaved changes" : "Settings are up to date"}</strong>
              <span>{hasChanges ? "Save before leaving so the shared app uses your changes." : "New scans are using the saved configuration."}</span>
            </div>
            <div className="settings-save-actions">
              {hasChanges ? (
                <button type="button" className="secondary-button" onClick={discardChanges} disabled={busy}>
                  <Undo2 size={16} />
                  Discard
                </button>
              ) : null}
              <button className="primary-button" disabled={!databaseReady || busy || !hasChanges}>
                <Save size={17} />
                {busy ? "Saving..." : "Save changes"}
              </button>
            </div>
          </footer>
        </form>
      </main>
    </AppShell>
  );
}

function SettingsSectionHeading({ number, title, description, ready, optional = false }) {
  return (
    <header className="settings-section-heading">
      <span className="settings-section-number">{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <span className={`settings-section-state ${ready ? "ok" : optional ? "optional" : "warn"}`}>
        {ready ? "Ready" : optional ? "Optional" : "Setup needed"}
      </span>
    </header>
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
