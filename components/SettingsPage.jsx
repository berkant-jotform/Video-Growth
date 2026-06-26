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
      ["THUMBNAIL_SPREADSHEET_ID", "Thumbnail spreadsheet ID or URL", "input"]
    ]
  },
  {
    title: "Google Read-Only Access",
    note: "Optional. Preferred private path: service account JSON. If Google Cloud access is blocked, leave this blank and share each cloned sheet as Anyone with the link: Viewer so the XLSX export fallback can read it.",
    advanced: true,
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
    note: "Chrome extension settings. Use the same connector token in the extension. Watcher tabs can use direct Studio URLs or channel IDs.",
    fields: [
      ["CONNECTOR_TOKEN", "Connector token", "input", true],
      ["CONNECTOR_CHANNELS", "Monitored channels", "textarea"]
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
    key: "connectorWatcherTabs",
    label: "Watcher Tab URLs",
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
          <p className="eyebrow">Connector Setup</p>
          <h2>Make the detector actually watch Studio</h2>
          <div className="setup-steps">
            <SetupStep
              number="1"
              title="Install extension"
              text="Load the Chrome extension in the browser profile that is logged into YouTube Studio."
              state={config?.configured?.connectorToken ? "Ready for extension" : "Needs token"}
            />
            <SetupStep
              number="2"
              title="Open watcher tabs"
              text="Use channel watcher buttons so Studio pages stay open for the channels you care about."
              state={watchingStudioCount(connectorStatus) > 0 ? `${watchingStudioCount(connectorStatus)} Studio tab${watchingStudioCount(connectorStatus) === 1 ? "" : "s"}` : "No open Studio tabs"}
              tone={watchingStudioCount(connectorStatus) > 0 ? "ok" : "warn"}
            />
            <SetupStep
              number="3"
              title="Wait or scan"
              text="Passive checks run near the start of each hour. Manual scan is only for testing right now."
              state="Hourly"
            />
          </div>
        </section>

        <InstallExtensionPanel
          connectorToken={connectorToken}
          connectorChannels={connectorChannels}
          connectorWatcherTabs={connectorWatcherTabs}
          onGenerateToken={() =>
            setForm((current) => ({ ...current, CONNECTOR_TOKEN: generateConnectorToken() }))
          }
        />

        <section className="settings-panel full-width watcher-manager-panel">
          <p className="eyebrow">Watcher Channels</p>
          <h2>Channels the extension can open</h2>
          <p className="muted">
            Add the channels you want watched. Use a YouTube channel ID starting with <code>UC</code> or a direct
            Studio channel URL. Save, then use the extension popup to open one channel or all channels.
          </p>
          <WatcherTabManager
            value={connectorWatcherTabs}
            connectorStatus={connectorStatus}
            onChange={(value) => setForm((current) => ({ ...current, CONNECTOR_WATCHER_TABS: value }))}
          />
          <button className="primary-button save-inline-button" type="button" disabled={!databaseReady} onClick={save}>
            <Save size={17} />
            Save Watcher Channels
          </button>
        </section>

        <section className="settings-panel config-panel">
          <p className="eyebrow">Configuration</p>
          <h2>Core app settings</h2>
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
            {SETTING_GROUPS.filter((group) => !group.advanced).map((group) => (
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
            <details className="settings-fieldset optional-settings">
              <summary>
                <span>
                  <strong>Optional integrations</strong>
                  <em>Google private access and Blob storage</em>
                </span>
              </summary>
              <div className="optional-settings-grid">
                {SETTING_GROUPS.filter((group) => group.advanced).map((group) => (
                  <fieldset className="settings-fieldset nested" disabled={!databaseReady} key={group.title}>
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
              </div>
            </details>
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button" disabled={!databaseReady}>
              <Save size={17} />
              Save App Settings
            </button>
          </form>
        </section>

        <section className="settings-panel readiness-panel">
          <p className="eyebrow">Health</p>
          <h2>What still needs fixing</h2>
          <div className="readiness-list">
            {READINESS_ITEMS.filter((item) => item.required).map((item) => (
              <SetupRow
                key={item.key}
                item={item}
                ready={Boolean(config?.configured?.[item.key])}
                location="Settings form"
              />
            ))}
            <details className="readiness-optional">
              <summary>Optional checks</summary>
              {READINESS_ITEMS.filter((item) => !item.required).map((item) => (
                <SetupRow
                  key={item.key}
                  item={item}
                  ready={Boolean(config?.configured?.[item.key])}
                  location="Settings form"
                />
              ))}
            </details>
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
                      <em>{connectorCoverageState(item)}</em>
                    </span>
                    <p>{(item.channels || []).join(", ") || "No channels reported"}</p>
                    <p className={connectorOpenStudioTabs(item) > 0 ? "coverage-ok" : "coverage-warning"}>
                      {connectorOpenStudioTabs(item) > 0
                        ? `${connectorOpenStudioTabs(item)} YouTube Studio tab${connectorOpenStudioTabs(item) === 1 ? "" : "s"} open at last heartbeat.`
                        : "Heartbeat is active, but no YouTube Studio tab was open. It cannot see finish notifications until Studio is open."}
                    </p>
                    <code>{item.connectorId}</code>
                  </div>
                  <div className="readiness-meta">
                    <strong className={item.active && connectorOpenStudioTabs(item) > 0 ? "ok" : "missing"}>
                      {item.active && connectorOpenStudioTabs(item) > 0 ? "Watching Studio" : item.active ? "Heartbeat only" : "No recent heartbeat"}
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

        <details className="settings-panel full-width advanced-settings">
          <summary>
            <span>
              <strong>Advanced cloud setup</strong>
              <em>Database, Vercel env, and password gate</em>
            </span>
          </summary>
          <p className="muted">
            These are infrastructure settings. Most reviewers do not need this section after the app is online.
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
        </details>
      </main>
    </AppShell>
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
    `Connector token: ${visibleToken || "generate-or-enter-token-first"}`,
    `Channels: ${connectorChannels}`,
    `Watcher tabs:\n${connectorWatcherTabs || "Add Studio URLs or channel IDs in Settings"}`
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
        Heartbeat only means the extension is alive. Detection only works when this page shows
        <strong> Watching Studio </strong> for at least one open Studio tab.
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
          <h3>4. Open watcher tabs</h3>
          <ol>
            <li>In Studio Connector settings below, add watcher tabs.</li>
            <li>Use one line per channel: <code>Jotform | UC...</code></li>
            <li>Open the extension popup.</li>
            <li>Click <strong>Open watcher tabs</strong>.</li>
          </ol>
          <p>The extension checks open Studio tabs hourly. Heartbeat alone is not detection.</p>
        </div>
        <div className="install-card">
          <h3>Watcher tab examples</h3>
          <p>Paste channel IDs or direct Studio URLs into the Watcher tabs field below.</p>
          <code>Jotform | UCxxxxxxxxxxxxxxxxxxxxxx</code>
          <code>AI Agents Podcast | https://studio.youtube.com/channel/UC...</code>
        </div>
        <div className="install-card">
          <h3>5. Confirm coverage</h3>
          <ol>
            <li>Open the extension popup.</li>
            <li>Click <strong>Send heartbeat</strong>.</li>
            <li>Refresh this Settings page.</li>
            <li>Look for <strong>Watching Studio</strong>, not just heartbeat.</li>
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
        <span>Studio URL or channel ID</span>
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
            {isWatcherOpen(row, openUrls) ? "Open" : "Not open"}
          </span>
          <button type="button" className="mini-remove-button" onClick={() => removeRow(index)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary-button add-watcher-button" onClick={addRow}>
        Add Channel
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

function connectorCoverageState(item) {
  if (!item.active) return "Stale";
  return connectorOpenStudioTabs(item) > 0 ? "Active" : "Blind";
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
