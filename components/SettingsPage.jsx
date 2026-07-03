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
    key: "connectorToken",
    label: "Extension Token",
    required: true,
    fix: "Create a random token here, save it, then paste the same token into the Chrome extension."
  },
  {
    key: "connectorChannels",
    label: "Watched Channels",
    required: true,
    fix: "Keep Jotform, AI Agents Podcast, and AI Agents first. Add other channel names as needed."
  },
  {
    key: "connectorWatcherTabs",
    label: "Studio Watchers",
    required: false,
    fix: "Optional but recommended. Add one per line: Channel name | Studio URL or YouTube channel ID."
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

const DEFAULT_WATCHER_ROWS = [
  { label: "Jotform", target: "" },
  { label: "AI Agents Podcast", target: "" },
  { label: "AI Agents", target: "" }
];

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
    event?.preventDefault?.();
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
  const connectorWatcherTabs = form.CONNECTOR_WATCHER_TABS || "";
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
                <legend>YouTube and extension</legend>
                {[
                  ["YOUTUBE_API_KEY", "YouTube API key", "input", true],
                  ["CONNECTOR_TOKEN", "Extension token", "input", true],
                  ["CONNECTOR_CHANNELS", "Watched channels", "textarea", false]
                ].map(([key, label, type, secret]) => (
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
              <ExtensionCoverageSummary connectorStatus={connectorStatus} />
            </div>
            <InstallExtensionPanel
              connectorToken={connectorToken}
              connectorChannels={connectorChannels}
              connectorWatcherTabs={connectorWatcherTabs}
              onGenerateToken={() =>
                setForm((current) => ({ ...current, CONNECTOR_TOKEN: generateConnectorToken() }))
              }
            />
            <section className="watcher-manager-panel">
              <h3>Studio watchers</h3>
              <p className="muted">Add one Studio watcher per channel, save, then open those channels from the extension.</p>
              <WatcherTabManager
                value={connectorWatcherTabs}
                connectorStatus={connectorStatus}
                onChange={(value) => setForm((current) => ({ ...current, CONNECTOR_WATCHER_TABS: value }))}
              />
            </section>
            <SectionReadiness keys={["youtubeApi", "connectorToken", "connectorChannels", "connectorWatcherTabs"]} config={config} />
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
          <button className="primary-button save-inline-button" disabled={!databaseReady}>
            <Save size={17} />
            Save Settings
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

function InstallExtensionPanel({ connectorToken, connectorChannels, connectorWatcherTabs, onGenerateToken }) {
  const appUrl = typeof window === "undefined" ? "https://video-growth.vercel.app" : window.location.origin;
  const visibleToken = connectorToken && connectorToken !== "********" ? connectorToken : "";
  const copyText = [
    `App URL: ${appUrl}`,
    `Extension token: ${visibleToken || "generate-or-enter-token-first"}`,
    `Channels: ${connectorChannels}`,
    `Studio watchers:\n${connectorWatcherTabs || "Add Studio URLs or channel IDs in Settings"}`
  ].join("\n");

  return (
    <section className="settings-panel full-width install-panel">
      <p className="eyebrow">Install Chrome Extension</p>
      <h2>Studio bell finish detector</h2>
      <p className="muted">
        This extension is the real finish signal. It runs in the Chrome profile that is logged into
        YouTube Studio, reads visible Studio notification text at the top of each hour or when you
        click manual scan, and reports matching finish events back to this app.
      </p>
      <p className="setup-warning">
        Detection only works when this page shows <strong> Watching </strong> for at least one open Studio watcher.
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
          Generate Extension Token
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
              <dt>Extension token</dt>
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
          <h3>4. Open Studio watchers</h3>
          <ol>
            <li>In Studio watcher settings below, add channel URLs or IDs.</li>
            <li>Use one line per channel: <code>Jotform | UC...</code></li>
            <li>Open the extension popup.</li>
            <li>Click <strong>Start watching + check</strong> in the extension.</li>
          </ol>
          <p>The extension checks open Studio watchers hourly. An extension check without Studio open is not detection.</p>
        </div>
        <div className="install-card">
          <h3>Watcher tab examples</h3>
          <p>Paste channel IDs or direct Studio URLs into the Studio watchers field below.</p>
          <code>Jotform | UCxxxxxxxxxxxxxxxxxxxxxx</code>
          <code>AI Agents Podcast | https://studio.youtube.com/channel/UC...</code>
        </div>
        <div className="install-card">
          <h3>5. Confirm coverage</h3>
          <ol>
            <li>Open the extension popup.</li>
            <li>Use <strong>Start watching + check</strong> or <strong>Check now</strong>.</li>
            <li>Refresh this Settings page.</li>
            <li>Look for <strong>Watching</strong>, not just connected.</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

function WatcherTabManager({ value, connectorStatus = [], onChange }) {
  const rows = parseWatcherRows(value);
  const openUrls = connectorStatus
    .flatMap((item) => item?.payload?.studioTabUrls || [])
    .filter(Boolean);

  function updateRow(index, patch) {
    const next = rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row));
    onChange(serializeWatcherRows(next));
  }

  function addRow() {
    onChange(serializeWatcherRows([...rows, { label: "", target: "" }]));
  }

  function removeRow(index) {
    onChange(serializeWatcherRows(rows.filter((_, idx) => idx !== index)));
  }

  return (
    <div className="watcher-manager">
      <div className="watcher-header">
        <span>Channel</span>
        <span>Studio watcher URL or channel ID</span>
        <span>Status</span>
      </div>
      {rows.map((row, index) => (
        <div className="watcher-row" key={`${index}-${row.label}`}>
          <input
            value={row.label}
            placeholder="Jotform"
            onChange={(event) => updateRow(index, { label: event.target.value })}
          />
          <input
            value={row.target}
            placeholder="UC... or https://studio.youtube.com/channel/UC..."
            onChange={(event) => updateRow(index, { target: event.target.value })}
          />
          <span className={`watcher-status ${isWatcherOpen(row, openUrls) ? "open" : "closed"}`}>
            {isWatcherOpen(row, openUrls) ? "Watching" : "Open tab needed"}
          </span>
          <button type="button" className="mini-remove-button" onClick={() => removeRow(index)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary-button add-watcher-button" onClick={addRow}>
        Add Studio Watcher
      </button>
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

function parseWatcherRows(value) {
  const lines = String(value || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    const separator = line.includes("|") ? "|" : line.includes("=") ? "=" : "";
    if (separator) {
      const [label, ...rest] = line.split(separator);
      return { label: label.trim(), target: rest.join(separator).trim() };
    }
    return { label: "", target: line };
  });
  return rows.length ? rows : DEFAULT_WATCHER_ROWS;
}

function serializeWatcherRows(rows) {
  return rows
    .map((row) => {
      const label = String(row.label || "").trim();
      const target = String(row.target || "").trim();
      if (!label && !target) return "";
      return label ? `${label} | ${target}` : target;
    })
    .filter(Boolean)
    .join("\n");
}

function isWatcherOpen(row, openUrls) {
  const target = String(row?.target || "").trim();
  const channelId =
    target.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] ||
    String(row?.label || "").match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] ||
    "";
  if (channelId) return openUrls.some((url) => String(url).includes(channelId));
  if (/^https:\/\/studio\.youtube\.com\//i.test(target)) {
    const normalized = target.replace(/\/+$/, "");
    return openUrls.some((url) => String(url).replace(/\/+$/, "").startsWith(normalized));
  }
  return false;
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
