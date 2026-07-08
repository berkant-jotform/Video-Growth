"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clipboard, Download, ExternalLink, KeyRound, Plus, Save, ShieldCheck } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const DEFAULT_WATCHER_ROWS = [
  { label: "Jotform", target: "" },
  { label: "AI Agents Podcast", target: "" },
  { label: "AI Agents", target: "" }
];

export default function ExtensionPage({ session }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({});
  const [generatedToken, setGeneratedToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setError("");
    const response = await fetch("/api/config");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not load extension settings.");
      return;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
  }

  async function save(nextForm = form, successMessage = "Extension settings saved.") {
    setMessage("");
    setError("");
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextForm)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not save extension settings.");
      return false;
    }
    setConfig(payload.config);
    setForm(payload.config.values || {});
    setMessage(successMessage);
    return true;
  }

  async function generateSaveAndCopyToken() {
    const token = generateConnectorToken();
    const next = { ...form, CONNECTOR_TOKEN: token };
    setGeneratedToken(token);
    setForm(next);
    const saved = await save(next, "New extension token saved. Paste it into the Chrome extension.");
    if (saved) await copyText(token, "Token copied.");
  }

  const appUrl = typeof window === "undefined" ? "https://video-growth.vercel.app" : window.location.origin;
  const connectorStatus = config?.connectorStatus || [];
  const activeStatus = connectorStatus.find((item) => item.active) || connectorStatus[0] || null;
  const connectorToken = form.CONNECTOR_TOKEN || "";
  const usableToken = generatedToken || (connectorToken && connectorToken !== "********" ? connectorToken : "");
  const channels = form.CONNECTOR_CHANNELS || "Jotform, AI Agents Podcast, AI Agents";
  const watcherTabs = form.CONNECTOR_WATCHER_TABS || "";
  const watcherRows = useMemo(() => parseWatcherRows(watcherTabs), [watcherTabs]);
  const openUrls = connectorStatus.flatMap((item) => item?.payload?.studioTabUrls || []).filter(Boolean);
  const copyValues = [
    `App URL: ${appUrl}`,
    `Extension token: ${usableToken || "Generate a new token first"}`,
    `Channels: ${channels}`,
    `Studio watchers:\n${watcherTabs || "Add watcher rows in this page"}`
  ].join("\n");

  return (
    <AppShell session={session} active="extension">
      <main className="workspace settings-grid extension-workspace">
        <section className="settings-panel full-width extension-hero-panel">
          <p className="eyebrow">Chrome extension</p>
          <h2>Real finish signal setup</h2>
          <p className="muted">
            The extension reads visible YouTube Studio and YouTube notification text from your logged-in Chrome profile.
            It does not change YouTube. Keep this page for setup; keep the Detector page for daily work.
          </p>
          <div className="extension-status-strip">
            <StatusTile
              label="Extension"
              value={activeStatus?.active ? "Connected" : "Not connected"}
              tone={activeStatus?.active ? "ok" : "warn"}
            />
            <StatusTile
              label="Studio tabs"
              value={connectorOpenStudioTabs(activeStatus) ? `${connectorOpenStudioTabs(activeStatus)} open` : "Open needed"}
              tone={connectorOpenStudioTabs(activeStatus) ? "ok" : "warn"}
            />
            <StatusTile
              label="Latest version"
              value={config?.latestExtensionVersion || "0.1.31"}
              tone="neutral"
            />
            <StatusTile
              label="Last checked"
              value={activeStatus?.lastSeenAt ? formatDateTime(activeStatus.lastSeenAt) : "Never"}
              tone={activeStatus?.active ? "ok" : "warn"}
            />
          </div>
        </section>

        <section className="settings-panel extension-token-panel">
          <p className="eyebrow">1. Token</p>
          <h2>Generate and save token</h2>
          <p className="muted">
            Use one shared extension token for the team. If the saved token is hidden as ********, generate a new one when setting up a new browser.
          </p>
          <label className="setting-field">
            <span>
              Extension token
              <em>{sourceLabel(config?.sources?.CONNECTOR_TOKEN)}</em>
            </span>
            <input
              type="password"
              value={connectorToken}
              placeholder="Click Generate, Save, Copy"
              onChange={(event) => {
                setGeneratedToken(event.target.value);
                setForm((current) => ({ ...current, CONNECTOR_TOKEN: event.target.value }));
              }}
            />
          </label>
          {generatedToken ? (
            <div className="extension-token-reveal">
              <strong>New token ready</strong>
              <code>{generatedToken}</code>
            </div>
          ) : null}
          <div className="install-actions compact">
            <button type="button" className="primary-button" onClick={generateSaveAndCopyToken}>
              <KeyRound size={16} />
              Generate, Save, Copy
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!usableToken}
              onClick={() => copyText(usableToken, "Token copied.")}
            >
              <Clipboard size={16} />
              Copy Token
            </button>
          </div>
        </section>

        <section className="settings-panel extension-token-panel">
          <p className="eyebrow">2. Install</p>
          <h2>Load the extension in Chrome</h2>
          <div className="extension-steps-list">
            <span><Download size={16} /> Download the zip.</span>
            <span><ExternalLink size={16} /> Open <code>chrome://extensions</code>.</span>
            <span><CheckCircle2 size={16} /> Enable Developer Mode and Load unpacked.</span>
          </div>
          <div className="install-actions compact">
            <a className="primary-button" href="/downloads/youtube-ab-tests-connector.zip" download>
              <Download size={16} />
              Download Extension Zip
            </a>
            <button type="button" className="secondary-button" onClick={() => copyText(copyValues, "Extension values copied.")}>
              <Clipboard size={16} />
              Copy Setup Values
            </button>
          </div>
        </section>

        <section className="settings-panel full-width">
          <p className="eyebrow">3. Watch channels</p>
          <h2>Studio watcher tabs</h2>
          <p className="muted">Add the channels the extension should keep open. Use a YouTube channel ID or direct Studio channel URL so the friendly channel name is backed by a stable ID.</p>
          <WatcherRows
            rows={watcherRows}
            openUrls={openUrls}
            onChange={(rows) =>
              setForm((current) => ({ ...current, CONNECTOR_WATCHER_TABS: serializeWatcherRows(rows) }))
            }
          />
          <label className="setting-field extension-channel-field">
            <span>
              Watched channel names
              <em>{sourceLabel(config?.sources?.CONNECTOR_CHANNELS)}</em>
            </span>
            <textarea
              value={channels}
              rows={3}
              onChange={(event) => setForm((current) => ({ ...current, CONNECTOR_CHANNELS: event.target.value }))}
            />
          </label>
          <div className="install-actions compact">
            <button type="button" className="primary-button" onClick={() => save()}>
              <Save size={16} />
              Save Extension Setup
            </button>
            <a className="secondary-button" href="/settings">
              <ExternalLink size={16} />
              Advanced Settings
            </a>
          </div>
        </section>

        <section className="settings-panel full-width">
          <p className="eyebrow">4. Confirm</p>
          <h2>Check coverage</h2>
          <div className="extension-check-grid">
            {connectorStatus.length ? (
              connectorStatus.slice(0, 6).map((item) => (
                <article className="extension-check-card" key={item.connectorId}>
                  <strong>
                    <ShieldCheck size={16} />
                    {item.actorName || "Chrome extension"}
                  </strong>
                  <span>{item.version || "Unknown version"}</span>
                  <p>{(item.channels || []).join(", ") || "No channels reported"}</p>
                  <em className={connectorOpenStudioTabs(item) ? "ok" : "warn"}>
                    {connectorOpenStudioTabs(item) ? `${connectorOpenStudioTabs(item)} Studio tabs open` : "Open Studio tabs from the extension"}
                  </em>
                  <small>{item.lastSeenAt ? `Last checked ${formatDateTime(item.lastSeenAt)}` : "Never checked"}</small>
                </article>
              ))
            ) : (
              <p className="muted">No extension check-in yet. Install the extension, paste the token, then click Check connection in the extension popup.</p>
            )}
          </div>
          <div className="install-actions compact diagnostic-actions">
            <a className="secondary-button" href="/api/troubleshooting/bundle" target="_blank" rel="noreferrer">
              <Download size={16} />
              Download Troubleshooting Bundle
            </a>
          </div>
        </section>

        {error ? <p className="form-error full-width">{error}</p> : null}
        {message ? <p className="form-success full-width">{message}</p> : null}
      </main>
    </AppShell>
  );
}

function StatusTile({ label, value, tone }) {
  return (
    <article className={`extension-status-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function WatcherRows({ rows, openUrls, onChange }) {
  function update(index, patch) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function add() {
    onChange([...rows, { label: "", target: "" }]);
  }

  function remove(index) {
    onChange(rows.filter((_, rowIndex) => rowIndex !== index));
  }

  return (
    <div className="watcher-manager extension-watcher-manager">
      <div className="watcher-header">
        <span>Channel</span>
        <span>Studio watcher URL or channel ID</span>
        <span>Status</span>
      </div>
      {rows.map((row, index) => (
        <div className="watcher-row" key={`${index}-${row.label}`}>
          <input value={row.label} placeholder="Jotform" onChange={(event) => update(index, { label: event.target.value })} />
          <input value={row.target} placeholder="UC... or https://studio.youtube.com/channel/UC..." onChange={(event) => update(index, { target: event.target.value })} />
          <span className={`watcher-status ${isWatcherOpen(row, openUrls) ? "open" : "closed"}`}>
            {isWatcherOpen(row, openUrls) ? "Watching" : "Open tab needed"}
          </span>
          <button type="button" className="mini-remove-button" onClick={() => remove(index)}>Remove</button>
        </div>
      ))}
      <button type="button" className="secondary-button add-watcher-button" onClick={add}>
        <Plus size={16} />
        Add watcher
      </button>
    </div>
  );
}

async function copyText(value, fallbackMessage) {
  await navigator.clipboard?.writeText(value);
  return fallbackMessage;
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
