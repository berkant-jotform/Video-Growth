"use client";

import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, ChevronDown, Clipboard, Download, ExternalLink, KeyRound, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";
import {
  DEFAULT_EXTENSION_RUNTIME_CONFIG,
  defaultExtensionRuntimeConfigJson,
  normalizeExtensionRuntimeConfig
} from "@/lib/extension-runtime-config.mjs";
import { selectConnectorTarget } from "@/lib/connector-routing.mjs";

const DEFAULT_WATCHER_ROWS = [
  { label: "Jotform", target: "" },
  { label: "AI Agents Podcast", target: "" },
  { label: "AI Agents", target: "" }
];
const QUICK_WATCHER_CHANNELS = ["Apps", "Sign", "Boards", "PDF Editor", "Workflow"];

export default function ExtensionPage({ session }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({});
  const [watcherDraftRows, setWatcherDraftRows] = useState(DEFAULT_WATCHER_ROWS);
  const [deviceTokens, setDeviceTokens] = useState([]);
  const [deviceLabel, setDeviceLabel] = useState(`${session?.actorName || "Reviewer"} Chrome`);
  const [generatedToken, setGeneratedToken] = useState(null);
  const [scanJobs, setScanJobs] = useState([]);
  const [bridge, setBridge] = useState({ status: "checking", version: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    checkBridge();
    const timer = window.setInterval(() => loadJobs(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function load() {
    setError("");
    try {
      const [configResponse, tokenResponse, jobsResponse] = await Promise.all([
        fetch("/api/config", { cache: "no-store" }),
        fetch("/api/connector/tokens", { cache: "no-store" }),
        fetch("/api/connector/jobs?limit=8", { cache: "no-store" })
      ]);
      const configPayload = await configResponse.json().catch(() => ({}));
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      const jobsPayload = await jobsResponse.json().catch(() => ({}));
      if (!configResponse.ok || !configPayload.ok) {
        throw new Error(configPayload.error || "Could not load extension settings.");
      }
      if (!tokenResponse.ok || !tokenPayload.ok) {
        throw new Error(tokenPayload.error || "Could not load browser connections.");
      }
      setConfig(configPayload.config);
      const values = configPayload.config.values || {};
      setForm(values);
      setWatcherDraftRows(
        Array.isArray(configPayload.config.resolvedWatcherTabs) && configPayload.config.resolvedWatcherTabs.length
          ? configPayload.config.resolvedWatcherTabs.map((item) => ({ label: item.label || "", target: item.url || "" }))
          : parseWatcherRows(values.CONNECTOR_WATCHER_TABS || "")
      );
      setDeviceTokens(tokenPayload.tokens || []);
      if (jobsResponse.ok && jobsPayload.ok) setScanJobs(jobsPayload.jobs || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load extension setup.");
    } finally {
      setLoading(false);
    }
  }

  async function loadJobs() {
    try {
      const response = await fetch("/api/connector/jobs?limit=8", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok) setScanJobs(payload.jobs || []);
    } catch {}
  }

  async function checkBridge() {
    try {
      const response = await requestExtensionMessage("ping-extension", {}, 2500);
      setBridge({ status: response?.ok ? "ready" : "missing", version: response?.version || "" });
    } catch {
      setBridge({ status: "missing", version: "" });
    }
  }

  async function connectThisBrowser() {
    const label = deviceLabel.trim();
    if (!label) {
      setError("Name this browser, for example BG work Chrome.");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/connector/pairings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not start browser pairing.");
      const paired = await requestExtensionMessage("pair-extension", {
        code: payload.pairing.code,
        appUrl,
        actorName: session?.actorName || "Reviewer",
        deviceLabel: label
      }, 30000);
      if (!paired?.ok) throw new Error(paired?.error || "The extension could not complete browser pairing.");
      setBridge({ status: "ready", version: paired.version || "1.0.0" });
      setMessage(`${paired.label || label} connected. No token copy is needed.`);
      await load();
    } catch (pairError) {
      setError(pairError.message || "Could not connect this browser. Install the latest extension and reload this page.");
    } finally {
      setBusy(false);
    }
  }

  async function runConnectionCheck() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const selectedChannels = parseChannelNames(channels);
      const targetConnectorId = selectConnectorTarget(connectorStatus, selectedChannels);
      const response = await fetch("/api/connector/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: selectedChannels, testType: "all", mode: "notifications", targetConnectorId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not queue browser check.");
      if (versionAtLeast(bridge.version, "1.0.0")) {
        try {
          await requestExtensionMessage("run-scan-job", { jobId: payload.job.jobId }, 120000);
        } catch {
          // The durable job remains queued and will be claimed by the extension's
          // background command poll even when the page bridge is unavailable.
        }
      }
      await loadJobs();
      setMessage("Browser check requested. It remains queued safely if Chrome is temporarily unavailable.");
    } catch (jobError) {
      setError(jobError.message || "Could not request a browser check.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelConnectionCheck(jobId) {
    setError("");
    try {
      const response = await fetch("/api/connector/jobs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not stop the browser check.");
      setMessage("Stop requested. Signals already found will be retained.");
      await loadJobs();
    } catch (cancelError) {
      setError(cancelError.message || "Could not stop the browser check.");
    }
  }

  async function save(nextForm = form, successMessage = "Extension settings saved.") {
    setMessage("");
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextForm)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save extension settings.");
      setConfig(payload.config);
      setForm(payload.config.values || {});
      setMessage(successMessage);
      return true;
    } catch (saveError) {
      setError(saveError.message || "Could not save extension settings.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createBrowserConnection() {
    const label = deviceLabel.trim();
    if (!label) {
      setError("Name this browser, for example BG work Chrome.");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/connector/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not create browser connection.");
      setGeneratedToken(payload.token);
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload.token.token);
          copied = true;
        }
      } catch {}
      setMessage(
        copied
          ? "Browser connection created and token copied. Paste it into the extension Settings now; it will not be shown again after leaving this page."
          : "Browser connection created. Copy the visible token now; it will not be shown again after leaving this page."
      );
      const tokenResponse = await fetch("/api/connector/tokens", { cache: "no-store" });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (tokenResponse.ok && tokenPayload.ok) setDeviceTokens(tokenPayload.tokens || []);
    } catch (createError) {
      setError(createError.message || "Could not create browser connection.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeBrowserConnection(tokenId) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/connector/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not disconnect browser.");
      setDeviceTokens((current) => current.map((item) => item.tokenId === tokenId ? { ...item, active: false, revokedAt: new Date().toISOString() } : item));
      setMessage("Browser connection revoked. Other browsers remain connected.");
    } catch (revokeError) {
      setError(revokeError.message || "Could not disconnect browser.");
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard(value, successMessage) {
    setError("");
    setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
    } catch (copyError) {
      setError(copyError.message || "Could not copy to the clipboard.");
    }
  }

  const appUrl = typeof window === "undefined" ? "https://video-growth.vercel.app" : window.location.origin;
  const connectorStatus = config?.connectorStatus || [];
  const activeStatus = connectorStatus.find((item) => item.active) || connectorStatus[0] || null;
  const bridgeSupportsPairing = bridge.status === "ready" && versionAtLeast(bridge.version, "1.0.0");
  const usableToken = generatedToken?.token || "";
  const channels = form.CONNECTOR_CHANNELS || "Jotform, AI Agents Podcast, AI Agents";
  const watcherTabs = serializeWatcherRows(watcherDraftRows);
  const runtimeConfigJson = form.EXTENSION_RUNTIME_CONFIG_JSON || defaultExtensionRuntimeConfigJson();
  const runtimeConfig = runtimeConfigFromJson(runtimeConfigJson);
  const runtimePreset = runtimeConfig.deepScanFallbackEnabled || runtimeConfig.scrollRounds >= 5 ? "thorough" : "balanced";
  const openUrls = connectorStatus.flatMap((item) => item?.payload?.studioTabUrls || []).filter(Boolean);
  const copyValues = [
    `App URL: ${appUrl}`,
    `Extension token: ${usableToken || "Create a browser connection first"}`,
    `Channels: ${channels}`,
    `Studio watchers:\n${watcherTabs || "Add watcher rows in this page"}`
  ].join("\n");

  function updateWatcherRows(rows, { announce = "" } = {}) {
    setWatcherDraftRows(rows);
    setForm((current) => ({
      ...current,
      CONNECTOR_WATCHER_TABS: serializeWatcherRows(rows),
      CONNECTOR_CHANNELS: watcherChannelNames(rows)
    }));
    if (announce) setMessage(announce);
  }

  function updateRuntimeConfig(patch) {
    const next = normalizeExtensionRuntimeConfig({ ...runtimeConfig, ...patch });
    setForm((current) => ({
      ...current,
      EXTENSION_RUNTIME_CONFIG_JSON: JSON.stringify(next, null, 2)
    }));
  }

  function applyRuntimePreset(preset) {
    updateRuntimeConfig(
      preset === "thorough"
        ? { waitForRowsMs: 7000, scrollRounds: 5, scrollDelayMs: 750, maxEvents: 100, deepScanFallbackEnabled: true }
        : { waitForRowsMs: 4500, scrollRounds: 3, scrollDelayMs: 650, maxEvents: 60, deepScanFallbackEnabled: false }
    );
    setMessage(preset === "thorough" ? "Thorough detection selected. Scans may take a few seconds longer." : "Balanced detection selected.");
    setError("");
  }

  async function saveExtensionSetup() {
    const namedRows = watcherDraftRows.filter((row) => String(row.label || row.target || "").trim());
    const duplicateLabels = duplicateWatcherLabels(namedRows);
    if (duplicateLabels.length) {
      setMessage("");
      setError(`Remove duplicate watcher ${duplicateLabels.length === 1 ? "channel" : "channels"}: ${duplicateLabels.join(", ")}.`);
      return;
    }
    const next = {
      ...form,
      CONNECTOR_WATCHER_TABS: serializeWatcherRows(namedRows),
      CONNECTOR_CHANNELS: watcherChannelNames(namedRows)
    };
    const unresolved = namedRows.filter((row) => !String(row.target || "").trim()).length;
    const saved = await save(
      next,
      unresolved
        ? `Saved ${namedRows.length} watcher channels. The app will auto-detect ${unresolved} missing channel ${unresolved === 1 ? "ID" : "IDs"} from scanned YouTube metadata when possible.`
        : `Saved ${namedRows.length} watcher channels. Open the extension popup and click Open missing watcher tabs.`
    );
    if (saved) setWatcherDraftRows(parseWatcherRows(next.CONNECTOR_WATCHER_TABS || ""));
  }

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
              value={config?.latestExtensionVersion || "Unknown"}
              tone="neutral"
            />
            <StatusTile
              label="Last checked"
              value={activeStatus?.lastSeenAt ? formatDateTime(activeStatus.lastSeenAt) : "Never"}
              tone={activeStatus?.active ? "ok" : "warn"}
            />
          </div>
        </section>

        {loading ? <p className="settings-message full-width" role="status">Loading extension setup...</p> : null}
        {error ? <p className="form-error full-width" role="alert">{error}</p> : null}
        {message ? <p className="form-success full-width" role="status">{message}</p> : null}

        {activeStatus?.active ? (
          <section className="extension-daily-note full-width">
            <CheckCircle2 size={19} />
            <span><strong>Setup is active.</strong> Use Detector for daily scans. Return here only to add a channel, connect another browser, or troubleshoot.</span>
            <a className="secondary-button compact-button" href="/">Open Detector</a>
          </section>
        ) : null}

        <section className="settings-panel full-width extension-control-plane">
          <div className="extension-control-heading">
            <div>
              <p className="eyebrow">App connection</p>
              <h2>Browser control center</h2>
              <p className="muted">The app can queue a check even when the page bridge is temporarily unavailable. A connected extension claims it automatically.</p>
            </div>
            <span className={`connection-pill ${bridgeSupportsPairing ? "ok" : "warn"}`}>
              {bridgeSupportsPairing
                ? `Direct connection · v${bridge.version}`
                : bridge.status === "ready"
                  ? `Update extension · v${bridge.version || "unknown"}`
                  : "Background queue available"}
            </span>
          </div>
          <div className="extension-control-actions">
            <label className="setting-field">
              <span>Browser name</span>
              <input value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} placeholder="BG work Chrome" />
            </label>
            <button type="button" className="primary-button" onClick={connectThisBrowser} disabled={busy || !bridgeSupportsPairing}>
              <KeyRound size={16} /> Connect this browser
            </button>
            <button type="button" className="secondary-button" onClick={runConnectionCheck} disabled={busy || !deviceTokens.some((item) => item.active)}>
              <BellRing size={16} /> Check watched channels
            </button>
          </div>
          <div className="extension-job-list">
            {scanJobs.length ? scanJobs.slice(0, 4).map((job) => <ExtensionJob key={job.jobId} job={job} onCancel={cancelConnectionCheck} />) : <p className="muted">No browser checks requested yet.</p>}
          </div>
        </section>

        <details className="settings-panel full-width extension-setup-details" open={!activeStatus?.active}>
          <summary>
            <span><strong>Install or connect another browser</strong><em>{deviceTokens.filter((item) => item.active).length} active browser connection{deviceTokens.filter((item) => item.active).length === 1 ? "" : "s"}</em></span>
            <ExternalLink size={17} />
          </summary>
          <div className="extension-setup-grid">
        <section className="extension-subpanel extension-token-panel">
          <p className="eyebrow">Browser connection</p>
          <h2>Connect this Chrome profile</h2>
          <p className="muted">
            Create a separate connection for each teammate or Chrome profile. You can revoke one browser without disconnecting everyone else.
          </p>
          <label className="setting-field">
            <span>
              Browser name
              <em>{deviceTokens.filter((item) => item.active).length} active</em>
            </span>
            <input
              value={deviceLabel}
              placeholder="BG work Chrome"
              onChange={(event) => setDeviceLabel(event.target.value)}
            />
          </label>
          {generatedToken ? (
            <div className="extension-token-reveal">
              <strong>Token copied. Paste it into the extension Settings.</strong>
              <code>{generatedToken.token}</code>
            </div>
          ) : null}
          <div className="install-actions compact">
            <button type="button" className="primary-button" onClick={createBrowserConnection} disabled={busy}>
              <KeyRound size={16} />
              Create and Copy Token
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!usableToken || busy}
              onClick={() => copyToClipboard(usableToken, "Token copied.")}
            >
              <Clipboard size={16} />
              Copy Token
            </button>
          </div>
          {deviceTokens.length ? (
            <div className="extension-device-list">
              {deviceTokens.map((item) => (
                <div className={`extension-device-row ${item.active ? "" : "revoked"}`} key={item.tokenId}>
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.active
                        ? item.lastUsedAt ? `Last used ${formatDateTime(item.lastUsedAt)}` : "Created; not used yet"
                        : "Disconnected"}
                    </small>
                  </div>
                  {item.active ? (
                    <button
                      type="button"
                      className="mini-remove-button"
                      disabled={busy}
                      onClick={() => revokeBrowserConnection(item.tokenId)}
                      aria-label={`Disconnect ${item.label}`}
                    >
                      <Trash2 size={14} />
                      Disconnect
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="extension-subpanel extension-token-panel">
          <p className="eyebrow">Chrome installation</p>
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
            <button type="button" className="secondary-button" onClick={() => copyToClipboard(copyValues, "Extension setup values copied.")}>
              <Clipboard size={16} />
              Copy Setup Values
            </button>
          </div>
        </section>
          </div>
        </details>

        <section className="settings-panel full-width">
          <p className="eyebrow">Watched channels</p>
          <h2>Studio watcher tabs</h2>
          <p className="muted">Add a channel name first. Paste its Studio channel URL or UC channel ID when available; rows without an ID are saved but clearly marked as not ready to open.</p>
          <WatcherRows
            rows={watcherDraftRows}
            openUrls={openUrls}
            quickChannels={QUICK_WATCHER_CHANNELS}
            onChange={updateWatcherRows}
          />
          <div className="install-actions compact">
            <button type="button" className="primary-button" onClick={saveExtensionSetup} disabled={busy}>
              <Save size={16} />
              Save Extension Setup
            </button>
            <a className="secondary-button" href="/settings">
              <ExternalLink size={16} />
              Advanced Settings
            </a>
          </div>
        </section>

        <details className="settings-panel full-width extension-advanced-panel">
          <summary>
            <span><strong>Detection reliability</strong><em>{runtimePreset === "thorough" ? "Thorough checks" : "Balanced checks"}</em></span>
            <ChevronDown size={18} />
          </summary>
          <div className="extension-advanced-body">
          <p className="muted">
            Changes are pulled by installed extensions automatically. Updating these settings does not require a new extension zip.
          </p>
          {config?.extensionRuntimeConfigError ? (
            <div className="settings-message error">
              Saved runtime rules could not be parsed. Safe defaults are being used until you save valid JSON.
            </div>
          ) : null}
          <div className="runtime-preset-grid" role="group" aria-label="Detection depth">
            <button
              type="button"
              className={`runtime-preset-button ${runtimePreset === "balanced" ? "active" : ""}`}
              onClick={() => applyRuntimePreset("balanced")}
            >
              <strong>Balanced</strong>
              <span>Best for normal daily checks</span>
            </button>
            <button
              type="button"
              className={`runtime-preset-button ${runtimePreset === "thorough" ? "active" : ""}`}
              onClick={() => applyRuntimePreset("thorough")}
            >
              <strong>Thorough</strong>
              <span>Waits longer and checks more notification rows</span>
            </button>
          </div>
          <div className="runtime-toggle-list">
            <label className="runtime-toggle-row">
              <input
                type="checkbox"
                checked={runtimeConfig.accessibleLabelsEnabled !== false}
                onChange={(event) => updateRuntimeConfig({ accessibleLabelsEnabled: event.target.checked })}
              />
              <span>
                <strong>Read background bell results</strong>
                <small>Uses YouTube's built-in notification labels when a background Studio tab refuses to open its bell menu.</small>
              </span>
            </label>
            <label className="runtime-toggle-row">
              <input
                type="checkbox"
                checked={runtimeConfig.openYoutubeFallback}
                onChange={(event) => updateRuntimeConfig({ openYoutubeFallback: event.target.checked })}
              />
              <span>
                <strong>Recover missing YouTube notification surfaces</strong>
                <small>Allow the extension to reuse or open YouTube only when a bell surface cannot be found.</small>
              </span>
            </label>
            <label className="runtime-toggle-row">
              <input
                type="checkbox"
                checked={runtimeConfig.includeSeenOnManualScan}
                onChange={(event) => updateRuntimeConfig({ includeSeenOnManualScan: event.target.checked })}
              />
              <span>
                <strong>Recheck previously seen notifications on manual scans</strong>
                <small>Safe duplicate protection remains active; this helps rematch older signals after sheet changes.</small>
              </span>
            </label>
          </div>
          <details className="runtime-advanced-details">
            <summary>Advanced detection rules</summary>
            <p className="muted">For troubleshooting only. Invalid or unsafe values are rejected and safe defaults remain active.</p>
            <label className="setting-field">
              <span>
                Runtime config JSON
                <em>{sourceLabel(config?.sources?.EXTENSION_RUNTIME_CONFIG_JSON)}</em>
              </span>
              <textarea
                value={runtimeConfigJson}
                rows={16}
                spellCheck={false}
                onChange={(event) => setForm((current) => ({ ...current, EXTENSION_RUNTIME_CONFIG_JSON: event.target.value }))}
              />
            </label>
          </details>
          <div className="install-actions compact">
            <button type="button" className="primary-button" onClick={() => save()}>
              <Save size={16} />
              Save Runtime Rules
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setForm((current) => ({ ...current, EXTENSION_RUNTIME_CONFIG_JSON: defaultExtensionRuntimeConfigJson() }))}
            >
              Reset Safe Defaults
            </button>
          </div>
          </div>
        </details>

        <details className="settings-panel full-width extension-advanced-panel" open={!activeStatus?.active}>
          <summary>
            <span><strong>Connection health and troubleshooting</strong><em>{activeStatus?.active ? "Healthy" : "Needs attention"}</em></span>
            <ChevronDown size={18} />
          </summary>
          <div className="extension-advanced-body">
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
          </div>
        </details>

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

function ExtensionJob({ job, onCancel }) {
  const progress = job.progress || {};
  const coverage = Array.isArray(progress.coverage) ? progress.coverage : Array.isArray(job.result?.coverage) ? job.result.coverage : [];
  const tone = ["completed"].includes(job.status) ? "ok" : ["failed", "partial"].includes(job.status) ? "warn" : "active";
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  return (
    <article className={`extension-job-row ${tone}`}>
      <span className="extension-job-indicator" aria-hidden="true" />
      <div>
        <strong>{jobTitle(job.status)}</strong>
        <small>{progress.message || job.error || scanJobScope(job)}</small>
        {["claimed", "running", "cancel_requested"].includes(job.status) ? <progress value={percent} max="100" aria-label={`Browser check ${percent}% complete`} /> : null}
        {coverage.length ? <em>{coverage.map((item) => `${item.channel}: ${coverageLabel(item.status)}`).join(" · ")}</em> : null}
      </div>
      <span className="extension-job-time">{formatDateTime(job.updatedAt || job.requestedAt)}</span>
      {["queued", "claimed", "running", "cancel_requested"].includes(job.status) ? (
        <button type="button" className="quiet-button compact-button" onClick={() => onCancel(job.jobId)} disabled={job.status === "cancel_requested"}>
          {job.status === "cancel_requested" ? "Stopping" : "Stop"}
        </button>
      ) : null}
    </article>
  );
}

function jobTitle(status) {
  if (status === "queued") return "Waiting for browser";
  if (status === "claimed" || status === "running") return "Checking channels";
  if (status === "cancel_requested") return "Stopping safely";
  if (status === "completed") return "Check completed";
  if (status === "partial") return "Partial check";
  if (status === "cancelled") return "Check stopped";
  return "Check failed";
}

function coverageLabel(value) {
  if (value === "checked") return "checked";
  if (value === "wrong_account") return "wrong account";
  if (value === "missing_tab") return "needs tab";
  return "failed";
}

function scanJobScope(job) {
  const channels = Array.isArray(job.channels) && job.channels.length ? job.channels.join(", ") : "All configured channels";
  return `${channels} · ${job.testType === "all" ? "all tests" : `${job.testType} tests`}`;
}

function parseChannelNames(value) {
  return Array.from(new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean)));
}

function versionAtLeast(value, minimum) {
  const left = String(value || "").split(".").map((item) => Number(item) || 0);
  const right = String(minimum || "").split(".").map((item) => Number(item) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}

function requestExtensionMessage(type, payload = {}, timeoutMs = 10000) {
  if (typeof window === "undefined") return Promise.reject(new Error("Browser extension bridge is unavailable."));
  const requestId = `ytab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Extension 1.0 did not respond from this browser tab."));
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window) return;
      const message = event.data || {};
      if (message.source !== "youtube-ab-tests-extension" || message.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(message.response || {});
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "youtube-ab-tests-app", type, requestId, payload }, window.location.origin);
  });
}

function WatcherRows({ rows, openUrls, quickChannels = [], onChange }) {
  function update(index, patch) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function add(label = "") {
    if (label && rows.some((row) => sameText(row.label, label))) {
      onChange(rows, { announce: `${label} is already in the watcher list.` });
      return;
    }
    onChange([...rows, { label, target: "" }], {
      announce: label
        ? `${label} watcher row added. Paste its Studio channel URL or UC channel ID, then save.`
        : "Watcher row added. Add a channel name and Studio URL or UC channel ID, then save."
    });
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
          <span className={`watcher-status ${watcherStatus(row, openUrls).state}`}>
            {watcherStatus(row, openUrls).label}
          </span>
          <button type="button" className="mini-remove-button" onClick={() => remove(index)}>Remove</button>
        </div>
      ))}
      <div className="watcher-actions">
        <button type="button" className="secondary-button add-watcher-button" onClick={() => add()}>
          <Plus size={16} />
          Add watcher
        </button>
        {quickChannels.map((channel) => (
          <button
            type="button"
            className="quiet-button"
            key={channel}
            onClick={() => add(channel)}
            disabled={rows.some((row) => sameText(row.label, channel))}
          >
            Add {channel}
          </button>
        ))}
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
  return rows.length ? dedupeWatcherRows(rows) : DEFAULT_WATCHER_ROWS;
}

function dedupeWatcherRows(rows) {
  const result = [];
  const indexByTarget = new Map();
  for (const row of rows) {
    const key = watcherRowTargetKey(row.target);
    if (!key || !indexByTarget.has(key)) {
      if (key) indexByTarget.set(key, result.length);
      result.push(row);
      continue;
    }
    const existingIndex = indexByTarget.get(key);
    if (!result[existingIndex].label && row.label) result[existingIndex] = row;
  }
  return result;
}

function watcherRowTargetKey(value) {
  const target = String(value || "").trim();
  if (!target) return "";
  const channelId = target.match(/(UC[A-Za-z0-9_-]{10,})/i)?.[1];
  if (channelId) return channelId.toLowerCase();
  return target.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
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

function duplicateWatcherLabels(rows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const label = String(row.label || "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) duplicates.add(label);
    seen.add(key);
  }
  return Array.from(duplicates);
}

function watcherChannelNames(rows = []) {
  const labels = rows
    .map((row) => String(row.label || "").trim())
    .filter(Boolean);
  return Array.from(new Set(labels)).join(", ");
}

function watcherStatus(row, openUrls) {
  const target = String(row?.target || "").trim();
  if (!target) return { state: "missing", label: "Auto-detect ID" };
  return isWatcherOpen(row, openUrls)
    ? { state: "open", label: "Watching" }
    : { state: "closed", label: "Open tab needed" };
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

function sameText(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function runtimeConfigFromJson(value) {
  try {
    return normalizeExtensionRuntimeConfig(JSON.parse(value));
  } catch {
    return normalizeExtensionRuntimeConfig(DEFAULT_EXTENSION_RUNTIME_CONFIG);
  }
}
