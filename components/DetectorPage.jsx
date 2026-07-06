"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BellRing,
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  Filter,
  Image,
  Info as InfoIcon,
  RefreshCw,
  Search,
  Type,
  X
} from "lucide-react";
import AppShell from "@/components/AppShell.jsx";
import { CHANNEL_PRIORITY, canonicalChannelName, compareChannels } from "@/lib/channels.mjs";

const SECTION_ORDER = [
  "action_conflict",
  "confirmed_finished",
  "applied_change_observed",
  "past_due_check",
  "uncovered",
  "watching",
  "sheet_changed_after_done",
  "missing_data"
];

const SECTION_LABELS = {
  action_conflict: "Action Conflict",
  confirmed_finished: "Confirmed Finished",
  applied_change_observed: "Applied Change Observed",
  past_due_check: "Needs Manual Check",
  uncovered: "Needs Signal",
  watching: "Watching",
  needs_review: "Explicit Sheet Finish",
  sheet_changed_after_done: "Sheet Updated After Action",
  missing_data: "Missing Data",
  result_logged: "Already Logged in Sheet",
  sheet_marked_done: "Marked Done in Sheet",
  running: "Running"
};

const OTHER_CHANNELS_LABEL = "Other channels";

const ACTIONS = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
  { value: "NO_CLEAR", label: "No Clear" },
  { value: "KEPT_CURRENT", label: "Kept Current" },
  { value: "RETEST_LATER", label: "Retest Later" },
  { value: "SKIP", label: "Skip" }
];

const CHANNEL_ACCENTS = new Map([
  ["Jotform", "#c5162e"],
  ["AI Agents Podcast", "#6f5cc2"],
  ["AI Agents", "#287d6b"],
  ["Apps", "#2f6f9f"],
  ["Sign", "#9b6a21"]
]);

const DEFAULT_CHANNEL_ACCENTS = ["#697386", "#596d7a", "#6f6a5c", "#70607a", "#5f7464"];
const OPENED_STUDIO_STORAGE_KEY = "youtube-ab-opened-studio-runs";
const COLLAPSED_CHANNELS_STORAGE_KEY = "youtube-ab-collapsed-channels";
const DETECTOR_VIEW_STORAGE_KEY = "youtube-ab-detector-view";
const REQUIRED_EXTENSION_VERSION = "0.1.27";

export default function DetectorPage({ session }) {
  const [runs, setRuns] = useState([]);
  const [unmatchedEvents, setUnmatchedEvents] = useState([]);
  const [connectorStatus, setConnectorStatus] = useState([]);
  const [connectorConfig, setConnectorConfig] = useState({ configured: false, channels: [], watcherTabs: [] });
  const [summary, setSummary] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [lastSuccessfulScan, setLastSuccessfulScan] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [modalRun, setModalRun] = useState(null);
  const [modalInitialAction, setModalInitialAction] = useState("");
  const [quickSaving, setQuickSaving] = useState("");
  const [scanChannels, setScanChannels] = useState([]);
  const [scanType, setScanType] = useState("all");
  const [refreshThumbnails, setRefreshThumbnails] = useState(false);
  const [detectorView, setDetectorView] = useState("classic");
  const [viewChannel, setViewChannel] = useState("all");
  const [viewType, setViewType] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [finishWindow, setFinishWindow] = useState("all");
  const [retestFilter, setRetestFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedStatus, setAdvancedStatus] = useState("all");
  const [openedStudioRuns, setOpenedStudioRuns] = useState(() => new Set());
  const [collapsedChannels, setCollapsedChannels] = useState(() => new Set());
  const [extensionRequest, setExtensionRequest] = useState({ status: "idle", message: "" });
  const [extensionBridge, setExtensionBridge] = useState({
    status: "checking",
    version: "",
    message: "Checking dashboard extension bridge..."
  });

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    let bridgeReady = false;
    let cancelled = false;
    let missingTimer = null;
    function markReady(version = "") {
      if (cancelled) return;
      bridgeReady = true;
      setExtensionBridge({
        status: "ready",
        version,
        message: version ? `Dashboard bridge ready (v${version}).` : "Dashboard bridge ready."
      });
      setExtensionRequest((current) =>
        current.status === "warn" && (!current.message || isBridgeOfflineMessage(current.message))
          ? { status: "idle", message: "" }
          : current
      );
    }
    function onMessage(event) {
      if (event.source !== window) return;
      const message = event.data || {};
      if (message.source !== "youtube-ab-tests-extension" || message.type !== "bridge-ready") return;
      markReady(message.version || "");
    }
    window.addEventListener("message", onMessage);
    requestExtension("ping-extension", { timeoutMs: 1600 })
      .then((response) => {
        if (response?.ok) markReady(response.version || "");
      })
      .catch(() => {
        missingTimer = window.setTimeout(() => {
          if (!bridgeReady && !cancelled) {
            setExtensionBridge({
              status: "missing",
              version: "",
              message: "The extension popup is separate; this dashboard page has not connected to the extension bridge yet."
            });
          }
        }, 150);
      });
    return () => {
      cancelled = true;
      if (missingTimer) window.clearTimeout(missingTimer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DETECTOR_VIEW_STORAGE_KEY);
      if (stored === "classic" || stored === "board") setDetectorView(stored);
    } catch {
      setDetectorView("classic");
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.removeItem(OPENED_STUDIO_STORAGE_KEY);
      const stored = window.sessionStorage.getItem(OPENED_STUDIO_STORAGE_KEY);
      if (stored) setOpenedStudioRuns(new Set(JSON.parse(stored)));
    } catch {
      setOpenedStudioRuns(new Set());
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSED_CHANNELS_STORAGE_KEY);
      if (stored) setCollapsedChannels(new Set(JSON.parse(stored)));
    } catch {
      setCollapsedChannels(new Set());
    }
  }, []);

  useEffect(() => {
    if (!scanning) return undefined;
    const interval = window.setInterval(() => {
      pollScanStatus();
    }, 1200);
    return () => window.clearInterval(interval);
  }, [scanning]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [queueResponse, statusResponse] = await Promise.all([
        fetch("/api/queue"),
        fetch("/api/status")
      ]);
      const queuePayload = await queueResponse.json();
      const statusPayload = await statusResponse.json();
      if (!queueResponse.ok || !queuePayload.ok) throw new Error(queuePayload.error || "Queue failed.");
      setRuns(queuePayload.runs || []);
      setUnmatchedEvents(queuePayload.unmatchedEvents || []);
      setConnectorStatus(queuePayload.connectorStatus || []);
      setConnectorConfig(statusPayload.connector || { configured: false, channels: [], watcherTabs: [] });
      setSummary(queuePayload.summary || null);
      setLastScan(statusPayload.lastScan || null);
      setLastSuccessfulScan(statusPayload.lastSuccessfulScan || null);
      setScanProgress(statusPayload.lastScan?.progress || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function pollScanStatus() {
    try {
      const response = await fetch("/api/status");
      const payload = await response.json();
      if (!response.ok || !payload.ok) return;
      setLastScan(payload.lastScan || null);
      setLastSuccessfulScan(payload.lastSuccessfulScan || null);
      setScanProgress(payload.lastScan?.progress || null);
      setConnectorStatus(payload.connectorStatus || []);
      setConnectorConfig(payload.connector || { configured: false, channels: [], watcherTabs: [] });
    } catch {
      // Progress polling is best-effort; the main scan request still reports failures.
    }
  }

  function setViewMode(value) {
    setDetectorView(value);
    try {
      window.localStorage.setItem(DETECTOR_VIEW_STORAGE_KEY, value);
    } catch {
      // View mode is personal presentation state only.
    }
  }

  async function scanNow() {
    return runScanRequest({
      channels: scanChannels,
      testType: scanType,
      refreshThumbnails: false,
      label: "selected scope"
    });
  }

  async function fullRefresh() {
    return runScanRequest({
      channel: "all",
      testType: "all",
      refreshThumbnails,
      label: "full refresh"
    });
  }

  async function scanChannelNow(channel) {
    return runScanRequest({
      channel: channel && channel !== OTHER_CHANNELS_LABEL ? channel : "all",
      testType: "all",
      refreshThumbnails: false,
      label: channel && channel !== OTHER_CHANNELS_LABEL ? channel : "all channels"
    });
  }

  async function runScanRequest({ channel = "all", channels = [], testType = "all", refreshThumbnails = false, label = "" } = {}) {
    const selectedChannels = channels.length ? channels : channel !== "all" ? [channel] : [];
    const scoped = {
      channel: selectedChannels.length === 1 ? selectedChannels[0] : "all",
      channels: selectedChannels,
      testType: testType !== "all" ? testType : "all",
      refreshThumbnails
    };
    const scopedText = [
      selectedChannels.length ? selectedChannels.join(", ") : "",
      scoped.testType !== "all" ? `${titleCase(scoped.testType)} tests` : ""
    ].filter(Boolean).join(" · ");
    setScanning(true);
    setError("");
    setScanProgress({
      stage: "starting",
      label: "Starting scan",
      detail: scopedText
        ? `Scanning only ${scopedText}.`
        : refreshThumbnails
          ? "Running a full refresh and rebuilding thumbnail previews."
          : `Running ${label || "scan"} without rebuilding thumbnail previews.`,
      percent: 2,
      counts: {}
    });
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scoped)
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Scan failed.");
      notifyBrowser("YouTube A/B Tests", `${payload.summary.total} items need attention.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function sendExtensionCommand(type) {
    setExtensionRequest({ status: "running", message: extensionCommandLoadingText(type) });
    try {
      const response = await requestExtension(type);
      if (!response?.ok) throw new Error(response?.error || "Extension did not complete the request.");
      const message =
        type === "check-studio-now"
          ? extensionScanSummary(response)
          : type === "open-notification-page"
            ? response.reused
              ? "YouTube home is already open for bell checks."
              : "YouTube home opened. Open the bell menu if needed, then click Check now."
            : "Miss report sent with the latest scan diagnostics.";
      setExtensionRequest({ status: "ok", message });
      window.setTimeout(() => refresh(), 800);
    } catch (err) {
      if (isBridgeOfflineMessage(err.message)) {
        setExtensionBridge({
          status: "missing",
          version: "",
          message: "Open the extension popup once; reload this page if it stays offline."
        });
        setExtensionRequest({ status: "warn", message: "" });
      } else {
        setExtensionRequest({
          status: "warn",
          message: err.message || "Extension request failed."
        });
      }
    }
  }

  function toggleScanChannel(channel) {
    if (channel === "all") {
      setScanChannels([]);
      return;
    }
    setScanChannels((current) =>
      current.includes(channel)
        ? current.filter((item) => item !== channel)
        : [...current, channel]
    );
  }

  async function ignoreRun(run) {
    if (!run?.testRunId) return;
    setQuickSaving(`${run.testRunId}:IGNORE`);
    setError("");
    const targetType = run.unregistered ? "finish_event" : "test_run";
    const targetId = run.unregistered ? run.finishEventId : run.testRunId;
    try {
      const response = await fetch("/api/resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          action: "ignore",
          metadata: { queueStatus: run.queueStatus, videoId: run.videoId, unregistered: Boolean(run.unregistered) }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not ignore item.");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setQuickSaving("");
    }
  }

  async function ignoreEvent(event) {
    if (!event?.eventId) return;
    setError("");
    try {
      const response = await fetch("/api/resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "finish_event",
          targetId: event.eventId,
          action: "ignore",
          metadata: { videoId: event.videoId, source: event.source }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not ignore signal.");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function matchEvent(event, testRunId) {
    if (!event?.eventId || !testRunId) return;
    setError("");
    try {
      const response = await fetch("/api/resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "finish_event",
          targetId: event.eventId,
          action: "match",
          testRunId,
          metadata: { videoId: event.videoId, source: event.source }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not match signal.");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function matchUnregisteredRun(run, suggestion) {
    if (!run?.finishEventId || !suggestion?.testRunId) return;
    setQuickSaving(`${run.testRunId}:MATCH`);
    setError("");
    try {
      const response = await fetch("/api/resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "finish_event",
          targetId: run.finishEventId,
          action: "match",
          testRunId: suggestion.testRunId,
          metadata: { videoId: run.videoId, source: run.finishEventSource, acceptedSuggestion: suggestion }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not accept match.");
      setSelected(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setQuickSaving("");
    }
  }

  async function quickComplete(run, action) {
    if (requiresRetestConfirmation(run)) {
      setModalInitialAction(action);
      setModalRun(run);
      return;
    }
    setQuickSaving(`${run.testRunId}:${action}`);
    setError("");
    try {
      const response = await fetch("/api/actions/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testRunId: run.testRunId, action, retestConfirmed: true })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save action.");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setQuickSaving("");
    }
  }

  function markStudioOpened(run) {
    if (!run?.testRunId) return;
    setOpenedStudioRuns((current) => {
      const next = new Set(current);
      next.add(run.testRunId);
      try {
        window.sessionStorage.setItem(OPENED_STUDIO_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // Session visual state is helpful but non-critical.
      }
      return next;
    });
  }

  function toggleChannelCollapsed(channelName) {
    setCollapsedChannels((current) => {
      const next = new Set(current);
      if (next.has(channelName)) {
        next.delete(channelName);
      } else {
        next.add(channelName);
      }
      try {
        window.localStorage.setItem(COLLAPSED_CHANNELS_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // Accordion state is local presentation only.
      }
      return next;
    });
  }

  const channels = useMemo(
    () => [
      "all",
      ...Array.from(new Set([
        ...(connectorConfig?.channels || []).map(displayChannel),
        ...(connectorConfig?.watcherTabs || []).map((tab) => displayChannel(tab.label)),
        ...runs.map((run) => displayChannel(run))
      ].filter(Boolean))).sort(compareChannels)
    ],
    [runs, connectorConfig]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return runs.filter((run) => {
      const runChannel = displayChannel(run);
      if (viewChannel !== "all" && runChannel !== viewChannel) return false;
      if (viewType !== "all" && run.testType !== viewType) return false;
      if (resultFilter !== "all" && !matchesResultFilter(run, resultFilter)) return false;
      if (finishWindow !== "all" && !matchesFinishWindow(run, finishWindow)) return false;
      if (retestFilter === "only" && !run.possibleRetest) return false;
      if (retestFilter === "hide" && run.possibleRetest) return false;
      if (advancedStatus !== "all" && statusKey(run) !== advancedStatus) return false;
      if (query) {
        const haystack = `${run.videoTitle} ${runChannel} ${run.channel} ${run.videoId} ${run.suggestedWinner}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [runs, viewChannel, viewType, resultFilter, finishWindow, retestFilter, advancedStatus, search]);

  const grouped = useMemo(
    () => groupRuns(filtered, { groupOtherChannels: viewChannel === "all" }),
    [filtered, viewChannel]
  );
  const primaryScanChannels = channels.filter((item) => item === "all" || isPrimaryScanChannel(item));
  const extraScanChannels = channels.filter((item) => item !== "all" && !isPrimaryScanChannel(item));

  return (
    <AppShell session={session} active="detector">
      <main className="workspace detector-workspace">
        <section className="hero-row">
          <div>
            <p className="eyebrow">Shared team queue</p>
            <h2>Real finish tracker</h2>
            <p className="muted">
              Last successful scan: {lastSuccessfulScan?.completedAt ? formatDateTime(lastSuccessfulScan.completedAt) : "No successful scan yet"}.
              Extension: {connectorSummary(connectorStatus)}
            </p>
            <div className="detector-view-toggle segmented" aria-label="Detector view">
              <button
                className={detectorView === "classic" ? "active" : ""}
                onClick={() => setViewMode("classic")}
                type="button"
              >
                Classic
              </button>
              <button
                className={detectorView === "board" ? "active" : ""}
                onClick={() => setViewMode("board")}
                type="button"
              >
                Channel Board
              </button>
            </div>
          </div>
          <div className="scan-scope-panel">
            <div className="scan-command-grid">
              <div className="scan-scope-fields">
                <div className="scan-channel-control">
                  <span className="filter-label">Scan channels</span>
                  <div className="scan-channel-chips" aria-label="Scan channels">
                    {primaryScanChannels.map((item) => {
                      const active = item === "all" ? scanChannels.length === 0 : scanChannels.includes(item);
                      return (
                        <button
                          key={item}
                          type="button"
                          className={active ? "active" : ""}
                          style={scanChipStyle(item)}
                          onClick={() => toggleScanChannel(item)}
                        >
                          {item === "all" ? "All channels" : item}
                        </button>
                      );
                    })}
                  </div>
                  <div className="scan-channel-meta">
                    <span>{scanChannels.length ? `${scanChannels.length} selected` : "All configured channels"}</span>
                    {extraScanChannels.length ? (
                      <details className="more-scan-channels">
                        <summary>More channels</summary>
                        <div className="scan-channel-chips compact" aria-label="More scan channels">
                          {extraScanChannels.map((item) => {
                            const active = scanChannels.includes(item);
                            return (
                              <button
                                key={item}
                                type="button"
                                className={active ? "active" : ""}
                                style={scanChipStyle(item)}
                                onClick={() => toggleScanChannel(item)}
                              >
                                {item}
                              </button>
                            );
                          })}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </div>
                <div className="filter-control scan-type-control">
                  <span className="filter-label">Scan type</span>
                  <div className="segmented" aria-label="Scan type">
                    {["all", "title", "thumbnail"].map((item) => (
                      <button
                        key={item}
                        className={scanType === item ? "active" : ""}
                        onClick={() => setScanType(item)}
                        type="button"
                      >
                        {item === "all" ? "All" : titleCase(item)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <ExtensionQuickCheck
                request={extensionRequest}
                bridge={extensionBridge}
                onCheck={() => sendExtensionCommand("check-studio-now")}
                onOpenNotifications={() => sendExtensionCommand("open-notification-page")}
                onReportMiss={() => sendExtensionCommand("report-missed-notification")}
              />
            </div>
            <div className="scan-action-row">
              <button className="primary-button scan-button" onClick={scanNow} disabled={scanning}>
                <RefreshCw size={18} className={scanning ? "spin" : ""} />
                {scanning ? "Scanning" : scanButtonLabel(scanChannels, scanType, "Scan selected")}
              </button>
              <button className="secondary-button full-refresh-button" onClick={fullRefresh} disabled={scanning}>
                <RefreshCw size={17} />
                Full refresh
              </button>
              <label className="refresh-thumb-toggle">
                <input
                  type="checkbox"
                  checked={refreshThumbnails}
                  onChange={(event) => setRefreshThumbnails(event.target.checked)}
                />
                Rebuild thumbnail previews
              </label>
            </div>
            <p className="scan-scope-help">
              Selected scan is scoped. Full refresh scans all sheets and reconciles missing rows. Thumbnail rebuild is slower and only needed when previews look stale.
            </p>
            <ExtensionScanReceipt connectorStatus={connectorStatus} compact />
          </div>
        </section>

        <ConnectorCoveragePanel
          connectorConfig={connectorConfig}
          connectorStatus={connectorStatus}
          runs={runs}
          selectedChannel={viewChannel}
        />

        <ScanProgress
          scan={lastScan}
          lastSuccessfulScan={lastSuccessfulScan}
          progress={scanProgress}
          scanning={scanning}
        />

        <Summary summary={summary} />

        <section className="filters">
          <label>
            View channel
            <select value={viewChannel} onChange={(event) => setViewChannel(event.target.value)}>
              {channels.map((item) => (
                <option key={item} value={item}>
                  {item === "all" ? "All channels" : item}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-control test-type-control">
            <span className="filter-label">View type</span>
            <div className="segmented" aria-label="View type">
              {["all", "title", "thumbnail"].map((item) => (
                <button
                  key={item}
                  className={viewType === item ? "active" : ""}
                  onClick={() => setViewType(item)}
                  type="button"
                >
                  {item === "all" ? "All" : titleCase(item)}
                </button>
              ))}
            </div>
          </div>
          <label>
            Result
            <select value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}>
              <option value="all">All results</option>
              <option value="action_conflict">Action conflict</option>
              <option value="confirmed">Confirmed finished</option>
              <option value="observed">Applied change observed</option>
              <option value="past_due_check">Needs manual check</option>
              <option value="watching">Watching</option>
              <option value="uncovered">Needs signal</option>
              <option value="not_determined">Not determined</option>
              <option value="missing_data">Cannot determine</option>
              <option value="sheet_changed">Changed after done</option>
              <option value="winner">Winner known</option>
              <option value="no_clear">No clear</option>
            </select>
          </label>
          <label>
            Signal time
            <select value={finishWindow} onChange={(event) => setFinishWindow(event.target.value)}>
              <option value="all">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="older">Older than 30 days</option>
              <option value="missing">Missing date</option>
            </select>
          </label>
          <label className="filter-control search-control">
            <span className="filter-label">Search</span>
            <span className="search-box">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search video, ID, channel"
              />
            </span>
          </label>
          <div className="advanced-filter">
            <button className="secondary-button" onClick={() => setAdvancedOpen((value) => !value)}>
              <Filter size={16} />
              More
              <ChevronDown size={16} />
            </button>
            {advancedOpen ? (
              <div className="filter-menu">
                <label>
                  Status
                  <select
                    value={advancedStatus}
                    onChange={(event) => setAdvancedStatus(event.target.value)}
                  >
                    <option value="all">All statuses</option>
                    {SECTION_ORDER.map((key) => (
                      <option key={key} value={key}>
                        {SECTION_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Retests
                  <select
                    value={retestFilter}
                    onChange={(event) => setRetestFilter(event.target.value)}
                  >
                    <option value="all">Show all</option>
                    <option value="only">Only retests</option>
                    <option value="hide">Hide retests</option>
                  </select>
                </label>
              </div>
            ) : null}
          </div>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <div className="empty-state">Loading queue</div> : null}
        {!loading && filtered.length === 0 ? (
          <div className="empty-state">
            No active test runs match the current filters. Run a scan or check History.
          </div>
        ) : null}

        {!loading && unmatchedEvents.length ? (
          <UnmatchedEvents events={unmatchedEvents} runs={runs} onIgnore={ignoreEvent} onMatch={matchEvent} />
        ) : null}

        {detectorView === "board" ? (
          <ChannelBoard
            runs={filtered}
            connectorConfig={connectorConfig}
            connectorStatus={connectorStatus}
            onDetails={setSelected}
            onDone={(run) => {
              setModalInitialAction("");
              setModalRun(run);
            }}
            onQuickAction={quickComplete}
            onIgnore={ignoreRun}
            onScanChannel={scanChannelNow}
            quickSaving={quickSaving}
            scanning={scanning}
            openedStudioRuns={openedStudioRuns}
            onStudioOpen={markStudioOpened}
            collapsedChannels={collapsedChannels}
            onToggleCollapsed={toggleChannelCollapsed}
          />
        ) : (
          <section className="channel-list">
            {grouped.map((group) => (
              <ChannelGroup
                key={group.channel}
                group={group}
                onDetails={setSelected}
                onDone={(run) => {
                  setModalInitialAction("");
                  setModalRun(run);
                }}
                onQuickAction={quickComplete}
                onIgnore={ignoreRun}
                quickSaving={quickSaving}
                openedStudioRuns={openedStudioRuns}
                onStudioOpen={markStudioOpened}
                collapsed={collapsedChannels.has(group.channel)}
                onToggleCollapsed={toggleChannelCollapsed}
              />
            ))}
          </section>
        )}
      </main>
      {selected ? (
        <DetailDrawer
          run={selected}
          onClose={() => setSelected(null)}
          opened={openedStudioRuns.has(selected.testRunId)}
          onStudioOpen={markStudioOpened}
          onAcceptMatch={matchUnregisteredRun}
          quickSaving={quickSaving}
        />
      ) : null}
      {modalRun ? (
        <DoneModal
          run={modalRun}
          onClose={() => setModalRun(null)}
          initialAction={modalInitialAction}
          onDone={async () => {
            setModalRun(null);
            setModalInitialAction("");
            await refresh();
          }}
        />
      ) : null}
    </AppShell>
  );
}

function Summary({ summary }) {
  const items = [
    ["Conflicts", summary?.actionConflict || 0],
    ["Confirmed", summary?.confirmedFinished || summary?.newlyFinished || 0],
    ["Unregistered", summary?.unregisteredSignals || 0],
    ["Observed", summary?.appliedChangeObserved || 0],
    ["Manual Check", summary?.pastDueCheck || 0],
    ["Needs Signal", summary?.uncovered || 0],
    ["Watching", summary?.watching || 0],
    ["Missing", summary?.missingData || 0],
    ["Total Active", summary?.total || 0]
  ];
  return (
    <section className="summary-grid">
      {items.map(([label, value]) => (
        <div className="summary-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function ScanProgress({ scan, lastSuccessfulScan, progress, scanning }) {
  const stale = isStaleRunningScan(scan);
  const active = scanning || (scan?.status === "running" && !stale);
  if (!active && !stale && !lastSuccessfulScan) return null;
  const percent = clampPercent(progress?.percent ?? 0);
  const counts = progress?.counts || {};
  const steps = progress?.steps || [];
  const countItems = [
    ["Title rows", counts.titleRows],
    ["Thumbnail rows", counts.thumbnailRows],
    ["Skipped by filter", counts.filteredRows],
    ["Previews", counts.thumbnailPreviews],
    ["YouTube rows", counts.enrichedRows],
    ["Signals", counts.appliedSignals]
  ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
  const timingItems = Object.entries(counts.timings || {})
    .filter(([key, value]) => key !== "total" && Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5);

  return (
    <section className={`scan-progress-panel ${stale ? "stale" : ""}`}>
      <div className="scan-progress-header">
        <div>
          <span className="eyebrow">{active ? "Current scan" : stale ? "Stale scan" : "Last successful scan"}</span>
          <h3>{active ? progress?.label || "Scanning" : stale ? "Previous scan did not finish cleanly" : "Queue is ready"}</h3>
          <p>
            {active
              ? stillWorkingText(scan, progress)
              : stale
                ? `Last update was ${progress?.updatedAt ? formatDateTime(progress.updatedAt) : "not recorded"}. Start a new scan if counts look old.`
                : `Completed ${formatDateTime(lastSuccessfulScan.completedAt)}.`}
          </p>
        </div>
        <strong>{active ? `${percent}%` : "OK"}</strong>
      </div>
      {active || stale ? (
        <div className="scan-progress-track" aria-label="Scan progress">
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {(active || stale) && steps.length ? (
        <div className="scan-step-list">
          {steps.map((step) => (
            <span className={`scan-step ${step.state}`} key={step.stage}>
              {step.label}
            </span>
          ))}
        </div>
      ) : null}
      {(active || stale) && countItems.length ? (
        <div className="scan-count-list">
          {countItems.map(([label, value]) => (
            <span key={label}>
              {label}: <strong>{value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {(active || stale) && timingItems.length ? (
        <div className="scan-timing-list">
          {timingItems.map(([key, value]) => (
            <span key={key}>
              {timingLabel(key)}: <strong>{formatDuration(value)}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {lastSuccessfulScan?.completedAt ? (
        <div className="last-successful-scan">
          Last successful scan: <strong>{formatDateTime(lastSuccessfulScan.completedAt)}</strong>
        </div>
      ) : null}
    </section>
  );
}

function ConnectorCoveragePanel({ connectorConfig, connectorStatus, runs, selectedChannel }) {
  const coverage = buildConnectorCoverage({ connectorConfig, connectorStatus, runs, selectedChannel });
  if (!coverage.channels.length) return null;

  return (
    <section className={`connector-coverage-panel ${coverage.tone}`}>
      <div className="connector-coverage-copy">
        <span className="eyebrow">Extension coverage</span>
        <h3>{coverage.title}</h3>
        <p>{coverage.message}</p>
        {coverage.versionWarning ? <p className="connector-version-warning">{coverage.versionWarning}</p> : null}
      </div>
      <div className="connector-channel-list">
        {coverage.channels.map((item) => (
          <span className={`connector-channel-chip ${item.state}`} key={item.channel}>
            <strong>{item.channel}</strong>
            <em>{item.label}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function ExtensionScanReceipt({ connectorStatus, compact = false }) {
  const receipt = latestExtensionScanReceipt(connectorStatus);
  if (!receipt) return null;
  const totals = receipt.scan.totals || {};
  const tabs = Array.isArray(receipt.scan.tabs) ? receipt.scan.tabs : [];
  const found = Number(totals.candidates || 0);
  const matched = Number(totals.matched || 0);
  const unmatched = Number(totals.unmatched || 0);
  const duplicate = Number(totals.duplicate || 0);
  const queued = Number(totals.queued || 0);
  const failed = Number(totals.failed || 0);
  const duplicateOnly = found > 0 && duplicate >= found && !matched && !unmatched && !queued && !Number(totals.received || 0);
  const diagnosis = duplicateOnly
    ? {
        severity: "ok",
        code: "already_processed",
        message: "The extension saw A/B finish text that was already processed.",
        action: ""
      }
    : receipt.scan.diagnosis || null;
  const diagnosisWarn = diagnosis?.severity === "warn" || diagnosis?.severity === "error";
  const received = Number(totals.received || 0);
  const processed = received + duplicate + queued;
  const tone = failed || diagnosisWarn ? "warn" : found || duplicate ? "ok" : "neutral";
  const stages = extensionScanStages(tabs, totals);
  const tabCount = Number(totals.tabs || tabs.length);
  const summaryText = `Checked ${tabCount} tab${tabCount === 1 ? "" : "s"}${receipt.scan.checkedAt ? ` at ${formatDateTime(receipt.scan.checkedAt)}` : ""}. Processed ${processed} signal${processed === 1 ? "" : "s"}: ${received} new, ${duplicate} already seen, ${queued} queued for retry. ${matched} matched, ${unmatched} unregistered.`;
  if (compact) {
    return (
      <details className={`extension-scan-receipt compact ${tone}`} open={Boolean(found || failed || diagnosisWarn)}>
        <summary>
          <span>
            <strong>Latest extension scan</strong>
            <em>{found ? `${found} A/B candidate${found === 1 ? "" : "s"} found` : "No finish candidates found"}</em>
          </span>
          <span className="extension-scan-mini-stats">
            <em>{matched} matched</em>
            <em>{unmatched} unregistered</em>
            {duplicate ? <em>{duplicate} already seen</em> : null}
          </span>
          <ChevronDown size={16} />
        </summary>
        <div className="extension-scan-receipt-body">
          <div className="extension-scan-copy">
            <p>{summaryText}</p>
            {diagnosis && diagnosis.severity !== "ok" ? (
              <div className={`extension-scan-diagnosis ${diagnosisWarn ? "warn" : "info"}`}>
                <strong>{diagnosisWarn ? "Scan warning" : "Scan note"}</strong>
                <span>{diagnosis.message}</span>
                {diagnosis.action ? <em>{diagnosis.action}</em> : null}
              </div>
            ) : null}
          </div>
          <div className="extension-scan-stage-row" aria-label="Extension scan stages">
            {stages.map((stage) => (
              <span className={`extension-scan-stage ${stage.state}`} key={stage.key}>
                <strong>{stage.label}</strong>
                <em>{stage.value}</em>
              </span>
            ))}
          </div>
        </div>
      </details>
    );
  }
  return (
    <section className={`extension-scan-receipt ${tone}`}>
      <div className="extension-scan-copy">
        <span className="eyebrow">Latest extension scan</span>
        <h3>
          {found
            ? `${found} A/B candidate${found === 1 ? "" : "s"} found`
            : "No A/B finish candidates found"}
        </h3>
        <p>{summaryText}</p>
        {diagnosis && diagnosis.severity !== "ok" ? (
          <div className={`extension-scan-diagnosis ${diagnosisWarn ? "warn" : "info"}`}>
            <strong>{diagnosisWarn ? "Scan warning" : "Scan note"}</strong>
            <span>{diagnosis.message}</span>
            {diagnosis.action ? <em>{diagnosis.action}</em> : null}
          </div>
        ) : null}
      </div>
      <div className="extension-scan-stats">
        <span>
          Candidates <strong>{found}</strong>
        </span>
        <span>
          Matched <strong>{matched}</strong>
        </span>
        {Number(totals.youtubeResolved || 0) ? (
          <span>
            YouTube resolved <strong>{Number(totals.youtubeResolved || 0)}</strong>
          </span>
        ) : null}
        <span>
          Needs matching <strong>{unmatched}</strong>
        </span>
        {duplicate ? (
          <span>
            Already seen <strong>{duplicate}</strong>
          </span>
        ) : null}
        {queued ? (
          <span>
            Queued retry <strong>{queued}</strong>
          </span>
        ) : null}
        {failed ? (
          <span>
            Failed tabs <strong>{failed}</strong>
          </span>
        ) : null}
      </div>
      <div className="extension-scan-stage-row" aria-label="Extension scan stages">
        {stages.map((stage) => (
          <span className={`extension-scan-stage ${stage.state}`} key={stage.key}>
            <strong>{stage.label}</strong>
            <em>{stage.value}</em>
          </span>
        ))}
      </div>
      {tabs.length ? (
        <details className="extension-scan-tabs">
          <summary>Checked tabs</summary>
          <div>
            {tabs.slice(0, 5).map((tab, index) => (
              <article key={`${tab.tabUrl || tab.tabTitle || "tab"}-${index}`}>
                <strong>{tab.channel || tab.tabTitle || "Studio tab"}</strong>
                <span>
                  {tab.menuOpened ? "Notification menu opened" : "Menu not opened"} · {Number(tab.candidates || 0)} candidate
                  {Number(tab.candidates || 0) === 1 ? "" : "s"} · {Number(tab.matched || 0)} matched
                </span>
                {tab.error ? <em>{tab.error}</em> : null}
                {Array.isArray(tab.previews) && tab.previews.length ? (
                  <ul>
                    {tab.previews.slice(0, 3).map((preview, previewIndex) => (
                      <li key={`${preview.title || preview.videoId || previewIndex}`}>
                        {preview.title || preview.videoId || preview.text || "A/B notification"}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function extensionScanStages(tabs, totals) {
  const openedMenus = tabs.filter((tab) => tab.menuOpened).length;
  const visibleTextTabs = tabs.filter((tab) => Number(tab.candidates || 0) > 0 || Number(tab.received || 0) > 0).length;
  const sent = Number(totals.received || 0);
  const matched = Number(totals.matched || 0);
  const unregistered = Number(totals.unmatched || 0);
  const youtubeResolved = Number(totals.youtubeResolved || 0);
  const duplicate = Number(totals.duplicate || 0);
  const queued = Number(totals.queued || 0);
  return [
    {
      key: "tabs",
      label: "Tabs checked",
      value: `${Number(totals.tabs || tabs.length || 0)}`,
      state: Number(totals.tabs || tabs.length || 0) ? "ok" : "warn"
    },
    {
      key: "bell",
      label: "Bell opened",
      value: openedMenus ? `${openedMenus}` : "0",
      state: openedMenus ? "ok" : "warn"
    },
    {
      key: "text",
      label: "Finish text",
      value: `${Number(totals.candidates || 0)}`,
      state: Number(totals.candidates || 0) || visibleTextTabs ? "ok" : "neutral"
    },
    {
      key: "sent",
      label: "New signals",
      value: `${sent}`,
      state: sent ? "ok" : duplicate || queued ? "neutral" : "warn"
    },
    {
      key: "duplicate",
      label: "Already seen",
      value: `${duplicate}`,
      state: duplicate ? "ok" : "neutral"
    },
    {
      key: "queued",
      label: "Queued retry",
      value: `${queued}`,
      state: queued ? "warn" : "neutral"
    },
    {
      key: "matched",
      label: "Auto-matched",
      value: `${matched}`,
      state: matched ? "ok" : sent && unregistered ? "warn" : "neutral"
    },
    {
      key: "youtube",
      label: "YouTube resolved",
      value: `${youtubeResolved}`,
      state: youtubeResolved ? "ok" : "neutral"
    },
    {
      key: "unregistered",
      label: "Unregistered",
      value: `${unregistered}`,
      state: unregistered ? "warn" : "neutral"
    }
  ];
}

function ExtensionQuickCheck({ request, bridge, onCheck, onOpenNotifications, onReportMiss }) {
  const running = request.status === "running";
  const tone = request.status === "ok" ? "ok" : request.status === "warn" ? "warn" : "neutral";
  const bridgeTone = bridge?.status === "ready" ? "ok" : bridge?.status === "missing" ? "warn" : "neutral";
  const requestMessage = isBridgeOfflineMessage(request.message) ? "" : request.message;
  return (
    <section className={`extension-quick-check ${tone}`}>
      <div className="extension-quick-copy">
        <span className="eyebrow">Real signal scan</span>
        <h3>Check visible Studio notifications</h3>
        <p>
          Reads open Studio tabs and the YouTube bell menu in this Chrome profile. It never edits YouTube.
        </p>
        <div className={`extension-bridge-status ${bridgeTone}`}>
          <strong>
            {bridge?.status === "ready"
              ? `Dashboard bridge ready${bridge.version ? ` · v${bridge.version}` : ""}`
              : bridge?.status === "missing"
                ? "Dashboard bridge offline"
                : "Checking dashboard bridge"}
          </strong>
          <span>
            {bridge?.status === "ready"
              ? "Website buttons can talk to the extension."
              : bridge?.status === "missing"
                ? "Open the extension popup once; reload this page if it stays offline."
                : "This should only take a moment."}
          </span>
        </div>
        {requestMessage ? <em>{requestMessage}</em> : null}
      </div>
      <div className="extension-quick-actions">
        <button className="primary-button" type="button" onClick={onCheck} disabled={running}>
          <BellRing size={17} />
          {running ? "Checking" : "Check now"}
        </button>
        <button className="secondary-button" type="button" onClick={onOpenNotifications} disabled={running}>
          Open YouTube home
        </button>
        <button className="quiet-button" type="button" onClick={onReportMiss} disabled={running}>
          I see a missed notification
        </button>
      </div>
    </section>
  );
}

function UnmatchedEvents({ events, runs, onIgnore, onMatch }) {
  const [open, setOpen] = useState(() => hasUsefulDebugSignals(events));
  const [selection, setSelection] = useState({});

  useEffect(() => {
    if (hasUsefulDebugSignals(events)) setOpen(true);
  }, [events]);

  const matchableRuns = useMemo(
    () => runs.filter((run) => run.status !== "missing_data"),
    [runs]
  );

  return (
    <section className={`unmatched-events needs-matching-signals ${open ? "open" : ""}`}>
      <button className="debug-signals-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        <span>
          <strong>Needs matching</strong>
          <em>{events.length} finished Studio signal{events.length === 1 ? "" : "s"} found but not linked to a sheet row</em>
        </span>
        <ChevronDown size={18} />
      </button>
      {open ? (
        <div className="unmatched-list">
          {events.slice(0, 6).map((event) => (
            <article className="unmatched-event" key={event.eventId}>
              <div>
                <strong>{event.videoTitle || event.channel || event.videoId || "Finished A/B test"}</strong>
                <span className="event-source-line">
                  Source: {eventSourceLabel(event.source)} · Needs matching to a sheet row
                  {event.videoId ? ` · Video ${event.videoId}` : ""}
                </span>
                <p>{event.rawText || "Studio notification captured without text."}</p>
                {event.notificationUrl ? (
                  <a href={event.notificationUrl} target="_blank" rel="noreferrer">
                    Open Studio page
                  </a>
                ) : null}
                <div className="match-signal-row">
                  <select
                    value={selection[event.eventId] || ""}
                    onChange={(changeEvent) =>
                      setSelection((current) => ({
                        ...current,
                        [event.eventId]: changeEvent.target.value
                      }))
                    }
                  >
                    <option value="">Select matching sheet row</option>
                    {suggestRunsForEvent(event, matchableRuns).slice(0, 12).map((run) => (
                      <option key={run.testRunId} value={run.testRunId}>
                        {displayChannel(run)} · {titleCase(run.testType)} · {matchStateLabel(run)} · {run.videoTitle || run.currentYoutubeTitle || run.videoId}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!selection[event.eventId]}
                    onClick={() => onMatch(event, selection[event.eventId])}
                  >
                    Match
                  </button>
                  <button className="text-button" type="button" onClick={() => onIgnore(event)}>
                    Ignore
                  </button>
                </div>
              </div>
              <span>{event.observedAt ? formatDateTimeWithExactAge(event.observedAt) : "No time"}</span>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function eventSourceLabel(source) {
  if (source === "studio_bell") return "Chrome extension Studio scrape";
  if (source === "studio_page_status") return "Studio page status";
  if (source === "metadata") return "YouTube metadata scan";
  if (source === "sheet") return "Sheet signal";
  return titleCase(source || "unknown source");
}

function ChannelBoard({
  runs,
  connectorConfig,
  connectorStatus,
  onDetails,
  onDone,
  onQuickAction,
  onIgnore,
  onScanChannel,
  quickSaving,
  scanning,
  openedStudioRuns,
  onStudioOpen,
  collapsedChannels,
  onToggleCollapsed
}) {
  const lanes = buildBoardLanes(runs);
  if (!lanes.length) {
    return <div className="empty-state">No board items match the current filters.</div>;
  }

  return (
    <section className="channel-board">
      {lanes.map((lane) => (
        <BoardLane
          key={lane.channel}
          lane={lane}
          connectorConfig={connectorConfig}
          connectorStatus={connectorStatus}
          onDetails={onDetails}
          onDone={onDone}
          onQuickAction={onQuickAction}
          onIgnore={onIgnore}
          onScanChannel={onScanChannel}
          quickSaving={quickSaving}
          scanning={scanning}
          openedStudioRuns={openedStudioRuns}
          onStudioOpen={onStudioOpen}
          collapsed={collapsedChannels.has(lane.channel)}
          onToggleCollapsed={onToggleCollapsed}
        />
      ))}
    </section>
  );
}

function BoardLane({
  lane,
  connectorConfig,
  connectorStatus,
  onDetails,
  onDone,
  onQuickAction,
  onIgnore,
  onScanChannel,
  quickSaving,
  scanning,
  openedStudioRuns,
  onStudioOpen,
  collapsed,
  onToggleCollapsed
}) {
  const coverage = boardCoverageForLane({ lane, connectorConfig, connectorStatus });
  const readyCount = lane.runs.filter((run) =>
    ["action_conflict", "confirmed_finished", "applied_change_observed"].includes(run.queueStatus)
  ).length;
  const manualCount = lane.runs.filter((run) => run.queueStatus === "past_due_check").length;
  return (
    <section
      className={`board-lane${collapsed ? " collapsed" : ""}`}
      style={{ "--channel-hue": channelHue(lane.channel), "--channel-accent": channelAccent(lane.channel) }}
    >
      <div className="board-lane-header">
        <button className="board-lane-title" type="button" onClick={() => onToggleCollapsed(lane.channel)}>
          <ChannelAvatar channel={lane.channel} logoUrl={lane.logoUrl} size="large" />
          <span>
            <strong>{lane.channel}</strong>
            <em>{coverage.label} · {lane.runs.length} active</em>
          </span>
          <ChevronDown size={18} />
        </button>
        <div className="board-lane-metrics">
          <span><strong>{readyCount}</strong> ready</span>
          <span><strong>{manualCount}</strong> manual</span>
        </div>
        <div className="board-lane-actions">
          <button className="secondary-button" type="button" onClick={() => onScanChannel(lane.channel)} disabled={scanning}>
            <RefreshCw size={16} />
            Scan channel
          </button>
          <span className="board-lane-hint">Deep scan lives in the Chrome extension.</span>
        </div>
      </div>
      {collapsed ? null : (
        <div className="board-card-list">
          {lane.runs.map((run) => (
            <BoardCard
              run={run}
              key={run.testRunId}
              onDetails={onDetails}
              onDone={onDone}
              onQuickAction={onQuickAction}
              onIgnore={onIgnore}
              quickSaving={quickSaving}
              opened={openedStudioRuns.has(run.testRunId)}
              onStudioOpen={onStudioOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BoardCard({ run, onDetails, onDone, onQuickAction, onIgnore, quickSaving, opened, onStudioOpen }) {
  const result = cardResult(run);
  const quickActions = quickActionOptions(run);
  const TypeIcon = run.testType === "thumbnail" ? Image : Type;
  return (
    <article
      className={`board-card ${statusKey(run)} ${run.testType}-test result-${result.key}${opened ? " studio-opened" : ""}`}
      style={{ "--channel-hue": channelHue(displayChannel(run)), "--channel-accent": channelAccent(displayChannel(run)) }}
    >
      <div className="board-card-main">
        <CardVisual run={run} result={result} />
        <div className="board-card-copy">
          <div className="card-badges">
            <span className={`type-pill ${run.testType}-type`}>
              <TypeIcon size={14} />
              {titleCase(run.testType)}
            </span>
            <span className={`result-pill ${result.tone}`}>{result.label}</span>
          </div>
          <h4>{run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video"}</h4>
          <p>{outcomeLabel(run)}</p>
          {run.unregistered ? <span className="badge warning">Not in A/B sheet</span> : null}
          {run.unregistered && run.signalResolution?.bestSuggestion ? (
            <span className="signal-resolution-note">Possible row: {formatSuggestion(run.signalResolution.bestSuggestion)}</span>
          ) : null}
        </div>
      </div>
      <div className="board-card-actions">
        <a
          className={`studio-button primary-studio-action${opened ? " opened" : ""}`}
          href={run.studioUrl || "#"}
          target="_blank"
          rel="noreferrer"
          onClick={() => onStudioOpen(run)}
        >
          {opened ? <Check size={17} /> : <ExternalLink size={17} />}
          {opened ? "Opened Studio" : "Open Studio"}
        </a>
        <div className="quick-actions" aria-label="Quick outcome actions">
          {quickActions.map((action) => (
            <button
              className={`quick-action ${action.toLowerCase()}`}
              key={action}
              title={`Mark ${action} done`}
              disabled={Boolean(quickSaving)}
              onClick={() => onQuickAction(run, action)}
            >
              {quickSaving === `${run.testRunId}:${action}` ? "..." : action}
            </button>
          ))}
        </div>
        <button className="mini-icon-button" title="Details" aria-label="Open details" onClick={() => onDetails(run)}>
          <InfoIcon size={14} />
        </button>
        <button
          className="mini-icon-button danger-mini-button"
          title="Ignore"
          aria-label="Ignore"
          disabled={quickSaving === `${run.testRunId}:IGNORE`}
          onClick={() => onIgnore(run)}
        >
          <X size={14} />
        </button>
      </div>
    </article>
  );
}

function ChannelGroup({
  group,
  onDetails,
  onDone,
  onQuickAction,
  onIgnore,
  quickSaving,
  openedStudioRuns,
  onStudioOpen,
  collapsed,
  onToggleCollapsed
}) {
  return (
    <section
      className={`channel-group${collapsed ? " collapsed" : ""}`}
      style={{ "--channel-hue": channelHue(group.channel), "--channel-accent": channelAccent(group.channel) }}
    >
      <button
        className="channel-heading"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggleCollapsed(group.channel)}
      >
        <div className="channel-heading-main">
          <ChannelAvatar channel={group.channel} logoUrl={group.channelLogoUrl} size="large" />
          <span className="channel-heading-title">{group.channel}</span>
        </div>
        <span className="channel-heading-meta">
          <strong>{group.count} active</strong>
          <ChevronDown size={18} />
        </span>
      </button>
      {!collapsed && group.channelCount > 1 ? (
        <p className="channel-group-note">{group.channelCount} lower-volume channels grouped here.</p>
      ) : null}
      {collapsed ? null : SECTION_ORDER.map((section) => {
        const runs = group.sections[section] || [];
        if (!runs.length) return null;
        return (
          <div className="status-section" key={section}>
            <div className="section-title">
              <span>{SECTION_LABELS[section]}</span>
              <span>{runs.length}</span>
            </div>
            <div className="card-grid">
              {runs.map((run) => (
                <TestCard
                  run={run}
                  key={run.testRunId}
                  onDetails={onDetails}
                  onDone={onDone}
                  onQuickAction={onQuickAction}
                  onIgnore={onIgnore}
                  quickSaving={quickSaving}
                  opened={openedStudioRuns.has(run.testRunId)}
                  onStudioOpen={onStudioOpen}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function TestCard({ run, onDetails, onDone, onQuickAction, onIgnore, quickSaving, opened, onStudioOpen }) {
  const result = cardResult(run);
  const channel = displayChannel(run);
  const quickActions = quickActionOptions(run);
  const TypeIcon = run.testType === "thumbnail" ? Image : Type;
  return (
    <article
      className={`test-card ${statusKey(run)} ${run.testType}-test result-${result.key}${opened ? " studio-opened" : ""}`}
      style={{ "--channel-hue": channelHue(channel), "--channel-accent": channelAccent(channel) }}
    >
      <div className="card-topline">
        <span className="channel-pill">
          <ChannelAvatar channel={channel} logoUrl={run.youtubeChannelThumbnailUrl} size="small" />
          {channel || "Unknown channel"}
        </span>
        <span className="card-top-actions">
          <button
            className="mini-icon-button"
            title="Copy video ID"
            aria-label="Copy video ID"
            onClick={() => copyText(run.videoId)}
          >
            <Clipboard size={14} />
          </button>
          <button
            className="mini-icon-button"
            title="Details"
            aria-label="Open details"
            onClick={() => onDetails(run)}
          >
            <InfoIcon size={14} />
          </button>
          <span className="date-pill">{signalDateLabel(run)}</span>
        </span>
      </div>
      <div className="card-badges">
        <span className={`type-pill ${run.testType}-type`}>
          <TypeIcon size={14} />
          {titleCase(run.testType)} test
        </span>
        <span className={`result-pill ${result.tone}`}>{result.label}</span>
      </div>
      <CardVisual run={run} result={result} />
      <h4>{run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video"}</h4>
      <p className="outcome compact">{outcomeLabel(run)}</p>
      {run.unregistered ? <span className="badge warning">Not in A/B sheet</span> : null}
      {run.unregistered && run.signalResolution?.bestSuggestion ? (
        <span className="signal-resolution-note">Possible row: {formatSuggestion(run.signalResolution.bestSuggestion)}</span>
      ) : null}
      {requiresRetestConfirmation(run) ? <span className="badge warning">Possible Retest</span> : null}
      <div className="card-actions">
        <a
          className={`studio-button primary-studio-action${opened ? " opened" : ""}`}
          href={run.studioUrl || "#"}
          target="_blank"
          rel="noreferrer"
          onClick={() => onStudioOpen(run)}
        >
          {opened ? <Check size={18} /> : <ExternalLink size={18} />}
          {opened ? "Opened Studio" : "Open Studio"}
        </a>
        <div className="quick-actions" aria-label="Quick outcome actions">
          {quickActions.map((action) => (
            <button
              className={`quick-action ${action.toLowerCase()}`}
              key={action}
              title={`Mark ${action} done`}
              disabled={Boolean(quickSaving)}
              onClick={() => onQuickAction(run, action)}
            >
              {quickSaving === `${run.testRunId}:${action}` ? "..." : action}
            </button>
          ))}
        </div>
        <button className="done-button" onClick={() => onDone(run)}>
          <Check size={17} />
          Done
        </button>
        <button
          className="ignore-button"
          onClick={() => onIgnore(run)}
          disabled={quickSaving === `${run.testRunId}:IGNORE`}
        >
          <X size={15} />
          {quickSaving === `${run.testRunId}:IGNORE` ? "Ignoring" : "Ignore"}
        </button>
      </div>
    </article>
  );
}

function CardVisual({ run, result }) {
  const channel = displayChannel(run);
  if (run.testType === "title" && Object.keys(run.options || {}).length) {
    return (
      <div className="card-visual title-option-visual">
        {["A", "B", "C"]
          .filter((key) => run.options?.[key])
          .map((key) => (
            <div className={`title-option-card option-${key.toLowerCase()}`} key={key}>
              <strong>{key}</strong>
              <span>{run.options[key]}</span>
            </div>
          ))}
      </div>
    );
  }

  const thumbnailKeys = ["A", "B", "C"].filter((key) => run.thumbnailPreviews?.[key]);
  if (run.testType === "thumbnail" && thumbnailKeys.length) {
    const primaryKeys = ["A", "B"].filter((key) => run.thumbnailPreviews?.[key]);
    const fallbackKeys = thumbnailKeys
      .filter((key) => !primaryKeys.includes(key))
      .slice(0, Math.max(0, 2 - primaryKeys.length));
    const shownKeys = [...primaryKeys, ...fallbackKeys];
    const extraKeys = thumbnailKeys.filter((key) => !shownKeys.includes(key));
    return (
      <div className={`card-visual thumbnail-visual-grid count-${shownKeys.length}`}>
        {shownKeys.map((key) => (
          <figure className={`option-${key.toLowerCase()}`} key={key}>
            <img src={run.thumbnailPreviews[key]} alt="" />
            <figcaption>{key}</figcaption>
          </figure>
        ))}
        {extraKeys.length ? (
          <span className="thumbnail-extra">+ {extraKeys.join("/")} available</span>
        ) : null}
      </div>
    );
  }

  if (run.currentYoutubeThumbnailUrl) {
    return (
      <div className="card-visual has-image">
        <img src={run.currentYoutubeThumbnailUrl} alt="" />
        <span>Current YouTube thumbnail</span>
      </div>
    );
  }
  return (
    <div className="card-visual visual-placeholder">
      <span>{result.label}</span>
      <strong>{channelInitials(channel)}</strong>
      <em>{titleCase(run.testType)} test</em>
    </div>
  );
}

function DetailDrawer({ run, onClose, opened, onStudioOpen, onAcceptMatch, quickSaving }) {
  return (
    <aside className="drawer">
      <button className="icon-button drawer-close" onClick={onClose} title="Close details">
        <X size={18} />
      </button>
      <p className="eyebrow">{displayChannel(run)}</p>
      <h2>{run.videoTitle || run.currentYoutubeTitle || run.videoId}</h2>
      <div className="detail-status">
        <span className={`badge ${statusKey(run)}`}>{SECTION_LABELS[statusKey(run)] || titleCase(statusKey(run))}</span>
        {run.suggestedWinner ? <strong>{run.suggestedWinner}</strong> : null}
      </div>
      <a
        className={`studio-button wide${opened ? " opened" : ""}`}
        href={run.studioUrl || "#"}
        target="_blank"
        rel="noreferrer"
        onClick={() => onStudioOpen(run)}
      >
        {opened ? <Check size={18} /> : <ExternalLink size={18} />}
        {opened ? "Opened Studio" : "Open Studio"}
      </a>
      <div className="detail-grid">
        <Info label="Video ID" value={run.videoId || "Missing"} />
        <Info label="Source row" value={run.unregistered ? "Not registered in A/B sheet" : `${run.sheetName} row ${run.rowNumber}`} />
        <Info label="Signal" value={signalSourceLabel(run)} />
        <Info label="Test lasted" value={testDurationLabel(run)} />
        <Info label="Extension" value={run.connectorCovered ? `Watching${run.connectorActorName ? ` by ${run.connectorActorName}` : ""}` : "Not watching"} />
        <Info label="Start" value={run.startDate || "Missing"} />
        <Info label="Sheet finish" value={run.effectiveFinishDate || "Blank"} />
      </div>
      {run.finishEventText ? (
        <section className="drawer-section">
          <h3>Finish Signal</h3>
          <p>{run.finishEventText}</p>
          <p className="muted">
            {signalSourceLabel(run)} · {finishSignalTimeLabel(run)} · {run.matchedConfidence || "matched"}
          </p>
        </section>
      ) : null}
      {run.unregistered ? (
        <section className="drawer-section">
          <h3>Sheet Match</h3>
          <p className="muted">{run.signalResolution?.reason || "No matching A/B sheet row found."}</p>
          {run.signalResolution?.suggestions?.length ? (
            <div className="match-suggestion-list">
              {run.signalResolution.suggestions.map((suggestion) => (
                <div className="match-suggestion-card" key={suggestion.testRunId}>
                  <div>
                    <strong>{suggestion.title || suggestion.videoId}</strong>
                    <span>
                      {suggestion.channel || "Unknown channel"} · {titleCase(suggestion.testType || "test")} · {suggestion.sheetName || "Sheet"} row {suggestion.rowNumber || "?"}
                    </span>
                    <em>{suggestion.reason} · {Math.round(Number(suggestion.score || 0) * 100)}% confidence</em>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onAcceptMatch?.(run, suggestion)}
                    disabled={quickSaving === `${run.testRunId}:MATCH`}
                  >
                    {quickSaving === `${run.testRunId}:MATCH` ? "Matching" : "Accept match"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No strong sheet candidate found. You can still handle this Studio signal directly from the card.</p>
          )}
          {run.signalResolution?.youtubeCandidates?.length ? (
            <div className="youtube-candidate-note">
              <strong>YouTube API candidates</strong>
              {run.signalResolution.youtubeCandidates.map((candidate) => (
                <span key={candidate.videoId}>
                  {candidate.title} · {candidate.channel || "Unknown channel"} · {Math.round(Number(candidate.score || 0) * 100)}%
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="drawer-section">
        <h3>Options</h3>
        {Object.entries(run.options || {}).length ? (
          Object.entries(run.options).map(([key, value]) => (
            <div className="option-row" key={key}>
              <strong>{key}</strong>
              <span>{value || "Blank"}</span>
            </div>
          ))
        ) : (
          <p className="muted">No text options in the sheet row.</p>
        )}
      </section>
      <section className="drawer-section">
        <h3>Watch-Time Share</h3>
        {Object.entries(run.watchTimeShare || {}).map(([key, value]) => (
          <div className="option-row" key={key}>
            <strong>{key}</strong>
            <span>{formatShare(value)}</span>
          </div>
        ))}
      </section>
      <section className="drawer-section">
        <h3>Current YouTube</h3>
        <p>{run.currentYoutubeTitle || "Not fetched"}</p>
        {run.currentYoutubeThumbnailUrl ? (
          <img className="current-thumb" src={run.currentYoutubeThumbnailUrl} alt="Current YouTube thumbnail" />
        ) : null}
      </section>
      {run.troubles?.length ? (
        <section className="drawer-section">
          <h3>Source Issues</h3>
          {run.troubles.map((trouble) => (
            <p className="issue" key={trouble.code}>
              <strong>{trouble.code}</strong> {trouble.message}
            </p>
          ))}
        </section>
      ) : null}
    </aside>
  );
}

function DoneModal({ run, initialAction = "", onClose, onDone }) {
  const [action, setAction] = useState(
    initialAction || (run.suggestedWinner?.match(/^[ABC]$/) ? run.suggestedWinner : "")
  );
  const needsRetestConfirmation = requiresRetestConfirmation(run);
  const [retestConfirmed, setRetestConfirmed] = useState(!needsRetestConfirmation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!action) {
      setError("Choose the outcome.");
      return;
    }
    if (needsRetestConfirmation && !retestConfirmed) {
      setError("Confirm this is a separate retest run.");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/actions/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testRunId: run.testRunId, action, retestConfirmed: needsRetestConfirmation ? retestConfirmed : true })
    });
    const payload = await response.json();
    setBusy(false);
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Could not save action.");
      return;
    }
    onDone();
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="icon-button modal-close" onClick={onClose} title="Close modal">
          <X size={18} />
        </button>
        <p className="eyebrow">Studio handled</p>
        <h2>{run.videoTitle || run.videoId}</h2>
        <div className="action-grid">
          {ACTIONS.map((item) => (
            <button
              className={action === item.value ? "active" : ""}
              key={item.value}
              onClick={() => setAction(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {needsRetestConfirmation ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={retestConfirmed}
              onChange={(event) => setRetestConfirmed(event.target.checked)}
            />
            This is a separate retest run for the same video.
          </label>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button wide" onClick={submit} disabled={busy}>
          {busy ? "Saving" : "Save Done"}
        </button>
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="info-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function requiresRetestConfirmation(run) {
  return Boolean(run.possibleRetest && !run.latestAction && run.queueStatus !== "sheet_changed_after_done");
}

function ChannelAvatar({ channel, logoUrl, size = "small" }) {
  const label = channel || "Unknown channel";
  if (logoUrl) {
    return <img className={`channel-avatar ${size}`} src={logoUrl} alt="" loading="lazy" />;
  }
  return <span className={`channel-avatar fallback ${size}`}>{channelInitials(label)}</span>;
}

function groupRuns(runs, { groupOtherChannels = false } = {}) {
  const map = new Map();
  for (const run of runs) {
    const channel = displayChannel(run) || "Unknown channel";
    const groupKey = groupOtherChannels && !isPriorityChannel(channel) ? OTHER_CHANNELS_LABEL : channel;
    if (!map.has(groupKey)) {
      map.set(groupKey, {
        channel: groupKey,
        count: 0,
        channelLogoUrl: "",
        originalChannels: new Set(),
        sections: {}
      });
    }
    const group = map.get(groupKey);
    group.count += 1;
    group.originalChannels.add(channel);
    if (!group.channelLogoUrl && groupKey !== OTHER_CHANNELS_LABEL && run.youtubeChannelThumbnailUrl) {
      group.channelLogoUrl = run.youtubeChannelThumbnailUrl;
    }
    const key = statusKey(run);
    group.sections[key] ||= [];
    group.sections[key].push(run);
  }
  for (const group of map.values()) {
    for (const runs of Object.values(group.sections)) {
      runs.sort(compareRunsWithinSection);
    }
  }
  return Array.from(map.values())
    .map((group) => ({ ...group, channelCount: group.originalChannels.size }))
    .sort(compareGroups);
}

function buildBoardLanes(runs) {
  const laneNames = [...CHANNEL_PRIORITY, OTHER_CHANNELS_LABEL];
  const map = new Map(laneNames.map((channel) => [channel, {
    channel,
    runs: [],
    logoUrl: ""
  }]));
  for (const run of runs) {
    const channel = displayChannel(run) || "Unknown channel";
    const laneKey = isPriorityChannel(channel) ? channel : OTHER_CHANNELS_LABEL;
    const lane = map.get(laneKey) || map.get(OTHER_CHANNELS_LABEL);
    lane.runs.push(run);
    if (!lane.logoUrl && laneKey !== OTHER_CHANNELS_LABEL && run.youtubeChannelThumbnailUrl) {
      lane.logoUrl = run.youtubeChannelThumbnailUrl;
    }
  }
  return Array.from(map.values())
    .filter((lane) => lane.runs.length)
    .map((lane) => ({
      ...lane,
      runs: lane.runs.sort(compareBoardRuns)
    }));
}

function compareBoardRuns(a, b) {
  const statusRank = boardStatusRank(statusKey(a)) - boardStatusRank(statusKey(b));
  if (statusRank !== 0) return statusRank;
  return compareRunsWithinSection(a, b);
}

function boardStatusRank(status) {
  const order = [
    "action_conflict",
    "confirmed_finished",
    "applied_change_observed",
    "past_due_check",
    "uncovered",
    "watching",
    "sheet_changed_after_done",
    "missing_data"
  ];
  const index = order.indexOf(status);
  return index >= 0 ? index : order.length;
}

function boardCoverageForLane({ lane, connectorConfig, connectorStatus }) {
  if (lane.channel === OTHER_CHANNELS_LABEL) return { state: "neutral", label: "Mixed coverage" };
  const coverage = buildConnectorCoverage({
    connectorConfig,
    connectorStatus,
    runs: lane.runs,
    selectedChannel: lane.channel
  });
  const item = coverage.channels.find((candidate) => sameChannel(candidate.channel, lane.channel));
  return item || { state: "missing", label: "Extension not connected" };
}

function compareRunsWithinSection(a, b) {
  const typeRank = testTypeRank(a.testType) - testTypeRank(b.testType);
  if (typeRank !== 0) return typeRank;
  return runSortTime(b) - runSortTime(a);
}

function testTypeRank(type) {
  if (type === "thumbnail") return 0;
  if (type === "title") return 1;
  return 2;
}

function runSortTime(run) {
  const value = run.finishEventAt || run.effectiveFinishDate || run.startDate || run.updatedAt || "";
  const time = new Date(value).valueOf();
  return Number.isFinite(time) ? time : 0;
}

function displayChannel(runOrChannel) {
  const raw = typeof runOrChannel === "string" ? runOrChannel : runOrChannel?.channel;
  return canonicalChannelName(raw) || raw || "";
}

function isPriorityChannel(channel) {
  const canonical = displayChannel(channel);
  return CHANNEL_PRIORITY.includes(canonical);
}

function isPrimaryScanChannel(channel) {
  const canonical = displayChannel(channel);
  return ["Jotform", "AI Agents Podcast", "AI Agents"].includes(canonical);
}

function compareGroups(a, b) {
  if (a.channel === OTHER_CHANNELS_LABEL && b.channel !== OTHER_CHANNELS_LABEL) return 1;
  if (b.channel === OTHER_CHANNELS_LABEL && a.channel !== OTHER_CHANNELS_LABEL) return -1;
  return compareChannels(a.channel, b.channel);
}

function statusKey(run) {
  return run.queueStatus || run.status || "needs_review";
}

function matchesResultFilter(run, filter) {
  if (filter === "action_conflict") return run.queueStatus === "action_conflict";
  if (filter === "confirmed") return run.queueStatus === "confirmed_finished";
  if (filter === "observed") return run.queueStatus === "applied_change_observed";
  if (filter === "past_due_check") return run.queueStatus === "past_due_check";
  if (filter === "watching") return run.queueStatus === "watching";
  if (filter === "uncovered") return run.queueStatus === "uncovered";
  return cardResult(run).key === filter;
}

function suggestRunsForEvent(event, runs) {
  return [...runs]
    .map((run) => ({
      run,
      score: eventRunSuggestionScore(event, run)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || runSortTime(b.run) - runSortTime(a.run))
    .map((item) => item.run);
}

function eventRunSuggestionScore(event, run) {
  let score = 0;
  if (event.videoId && run.videoId === event.videoId) score += 100;
  if (event.channel && sameChannel(event.channel, run.channel)) score += 25;
  const eventTitle = normalizeText(event.videoTitle || event.rawText || "");
  const candidates = [run.videoTitle, run.currentYoutubeTitle, ...(Object.values(run.options || {}))]
    .map(normalizeText)
    .filter(Boolean);
  for (const candidate of candidates) {
    if (eventTitle && candidate && (eventTitle.includes(candidate) || candidate.includes(eventTitle))) {
      score += 50;
      break;
    }
    const overlap = tokenOverlap(eventTitle, candidate);
    if (overlap >= 0.6) score += Math.round(overlap * 40);
  }
  if (run.queueStatus === "watching" || run.queueStatus === "uncovered") score += 4;
  return score;
}

function tokenOverlap(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter((token) => token.length >= 3));
  const right = new Set(normalizeText(b).split(" ").filter((token) => token.length >= 3));
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.min(left.size, right.size);
}

function outcomeLabel(run) {
  if (run.unregistered) return "Studio says this test finished, but no matching row exists in the configured A/B sheet.";
  if (run.queueStatus === "action_conflict") return `Tool says ${run.latestAction}; sheet now says ${sheetResultText(run)}. Resolve before closing.`;
  if (run.queueStatus === "sheet_changed_after_done") return "Sheet changed after the tool action; review only if this was unexpected";
  if (run.queueStatus === "confirmed_finished") {
    if (run.finishEventSource === "studio_bell") return "Studio notification confirmed this test finished";
    if (run.finishEventSource === "studio_page_status") return "Studio edit page says this test finished";
    return "Explicit sheet finish/result signal";
  }
  if (run.queueStatus === "applied_change_observed") return "Visible YouTube metadata changed to a B/C option";
  if (run.queueStatus === "past_due_check") return "No real finish signal yet; open Studio only if you want a manual check";
  if (run.queueStatus === "uncovered") return "No active extension is watching this channel";
  if (run.queueStatus === "watching") return "Active test; no real finish signal yet";
  if (run.status === "result_logged") return "Result already entered in sheet";
  if (run.status === "sheet_marked_done") return "Marked done in sheet";
  if (run.status === "missing_data") return "Missing source data";
  return run.winnerReason || titleCase(run.status);
}

function cardResult(run) {
  if (run.unregistered) {
    const detected = detectedOutcomeLabel(run.finishEventOutcome || run.detectedOutcome);
    const noClearReason = noClearReasonLabel(run);
    return {
      key: detected.key === "no_clear" ? "no_clear" : detected.key === "winner" ? "winner" : "unregistered",
      label: detected.label || "Unregistered",
      value: detected.key === "no_clear" ? noClearReason : "Not in A/B sheet",
      tone: detected.tone || "warning"
    };
  }
  if (run.queueStatus === "action_conflict") {
    return { key: "action_conflict", label: "Conflict", value: "Tool vs sheet", tone: "danger" };
  }
  if (run.queueStatus === "sheet_changed_after_done") {
    return { key: "sheet_changed", label: "Sheet updated", value: "After action", tone: "manual" };
  }
  if (run.queueStatus === "confirmed_finished") {
    const detected = detectedOutcomeLabel(run.finishEventOutcome || run.detectedOutcome);
    const noClearReason = noClearReasonLabel(run);
    return {
      key: detected.key === "winner" ? "winner" : detected.key === "no_clear" ? "no_clear" : "confirmed",
      label: detected.label || "Confirmed",
      value: detected.key === "no_clear" ? noClearReason : signalSourceLabel(run),
      tone: detected.tone || "success"
    };
  }
  if (run.queueStatus === "applied_change_observed") {
    const detected = detectedOutcomeLabel(run.finishEventOutcome);
    return {
      key: "observed",
      label: detected.label || "B/C observed",
      value: "Not final proof",
      tone: "info"
    };
  }
  if (run.queueStatus === "past_due_check") {
    return { key: "past_due_check", label: "Manual check", value: "Backup check", tone: "manual" };
  }
  if (run.queueStatus === "uncovered") {
    return { key: "uncovered", label: "Needs signal", value: "Extension needed", tone: "warning" };
  }
  if (run.queueStatus === "watching") {
    return { key: "watching", label: "Watching", value: "No finish signal", tone: "neutral" };
  }
  if (run.status === "missing_data") {
    return { key: "missing_data", label: "Cannot determine", value: "Missing data", tone: "danger" };
  }
  if (run.suggestedWinner?.match(/^[ABC]$/)) {
    return { key: "winner", label: `Winner ${run.suggestedWinner}`, value: `Option ${run.suggestedWinner}`, tone: "success" };
  }
  if (run.detectedOutcome === "no_clear" || run.suggestedWinner === "No clear winner") {
    return { key: "no_clear", label: "No clear", value: noClearReasonLabel(run), tone: "warning" };
  }
  if (run.status === "result_logged") {
    return { key: "logged", label: "Logged", value: "Already in sheet", tone: "neutral" };
  }
  if (run.status === "sheet_marked_done") {
    return { key: "logged", label: "Done", value: "Marked in sheet", tone: "neutral" };
  }
  return { key: "not_determined", label: "Not determined", value: "Review in Studio", tone: "neutral" };
}

function sheetResultText(run) {
  const outcome = String(run.detectedOutcome || "");
  const winner = outcome.match(/^winner_([abc])$/i)?.[1];
  if (winner) return winner.toUpperCase();
  if (outcome === "no_clear" || run.suggestedWinner === "No clear winner") return "No Clear";
  return run.suggestedWinner || "a different result";
}

function detectedOutcomeLabel(outcome) {
  const text = String(outcome || "");
  const winner = text.match(/^winner_([abc])$/i);
  if (winner) {
    const option = winner[1].toUpperCase();
    return { key: "winner", label: `Winner ${option}`, tone: "success" };
  }
  if (text === "no_clear") return { key: "no_clear", label: "No clear", tone: "warning" };
  if (text === "finished_unknown") return { key: "confirmed", label: "Confirmed", tone: "success" };
  return { key: "", label: "", tone: "" };
}

function noClearReasonLabel(run) {
  const text = [
    run.finishEventText,
    run.winnerReason,
    run.suggestedWinner,
    run.detectedOutcome,
    run.finishEventOutcome
  ].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("not enough views")) return "Not enough views";
  if (text.includes("not enough impressions")) return "Not enough impressions";
  if (text.includes("not enough data")) return "Not enough data";
  if (text.includes("not enough traffic")) return "Not enough traffic";
  if (text.includes("similar performance") || text.includes("performed well for all")) return "Similar performance";
  if (text.includes("no winner") || text.includes("no clear") || text.includes("inconclusive")) return "No winner";
  return "No clear result";
}

function quickActionOptions(run) {
  const available = Object.keys(run.options || {}).filter((key) => ["A", "B", "C"].includes(key));
  const base = available.length ? available : ["A", "B"];
  return base.includes("C") ? ["A", "B", "C"] : ["A", "B"];
}

function matchesFinishWindow(run, windowValue) {
  const signalDate = dateOnlyText(run.finishEventAt) || run.effectiveFinishDate;
  if (windowValue === "missing") return !signalDate;
  if (!signalDate) return false;
  const days = daysSince(signalDate);
  if (!Number.isFinite(days)) return false;
  if (windowValue === "older") return days > 30;
  return days >= 0 && days <= Number(windowValue);
}

function isStaleRunningScan(scan) {
  if (scan?.status !== "running" || !scan.startedAt) return false;
  return Date.now() - new Date(scan.startedAt).valueOf() > 10 * 60 * 1000;
}

function stillWorkingText(scan, progress) {
  const started = scan?.startedAt ? new Date(scan.startedAt).valueOf() : 0;
  const elapsedSeconds = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  if (elapsedSeconds > 30) {
    return `Still working for ${formatElapsed(elapsedSeconds)}. ${progress?.detail || "Updating queue data."}`;
  }
  return progress?.detail || "Working through sheets, thumbnails, YouTube data, and finish signals.";
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function hasUsefulDebugSignals(events = []) {
  return events.some((event) => {
    const text = String(event.rawText || "").toLowerCase();
    return Boolean(
      event.videoId ||
        text.includes("a/b test") ||
        text.includes("test completed") ||
        text.includes("finished")
    );
  });
}

function signalDateLabel(run) {
  if (run.finishEventNotificationAge) return normalizeNotificationAgeLabel(run.finishEventNotificationAge);
  if (run.finishEventAt) return formatDateTimeWithExactAge(run.finishEventAt);
  if (run.queueStatus === "past_due_check") return "Manual check";
  if (run.effectiveFinishDate) return `Sheet ${formatDateWithExactAge(run.effectiveFinishDate)}`;
  return "No signal yet";
}

function finishSignalTimeLabel(run) {
  const exactAge = run.finishEventNotificationAge ? normalizeNotificationAgeLabel(run.finishEventNotificationAge) : "";
  if (run.finishEventAt && exactAge) return `${formatDateTime(run.finishEventAt)} · ${exactAge}`;
  if (run.finishEventAt) return formatDateTimeWithExactAge(run.finishEventAt);
  return exactAge || "No timestamp";
}

function signalSourceLabel(run) {
  if (run.unregistered) return "Studio signal only";
  if (run.finishEventSource === "studio_bell") return "Studio extension";
  if (run.finishEventSource === "studio_page_status") return "Studio page status";
  if (run.finishEventSource === "metadata") return "Metadata observed";
  if (run.queueStatus === "past_due_check") return "Manual backup";
  if (run.queueStatus === "confirmed_finished" && run.effectiveFinishDate) return "Sheet finish date";
  if (run.queueStatus === "watching") return "Watching";
  if (run.queueStatus === "uncovered") return "Uncovered";
  return "No signal";
}

function testDurationLabel(run) {
  const endDate = signalEndDate(run);
  if (!run.startDate || !endDate) return "Unknown";
  const start = new Date(`${run.startDate}T00:00:00`);
  const end = new Date(endDate);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start) return "Unknown";
  const hours = Math.max(1, Math.round((end - start) / 3600000));
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function signalEndDate(run) {
  if (run.finishEventAt) return run.finishEventAt;
  if (run.effectiveFinishDate) return `${run.effectiveFinishDate}T00:00:00`;
  return "";
}

function matchStateLabel(run) {
  if (run.queueStatus === "confirmed_finished") return "Confirmed";
  if (run.queueStatus === "applied_change_observed") return "Observed";
  if (run.queueStatus === "past_due_check") return "Manual check";
  if (run.queueStatus === "watching" || run.queueStatus === "uncovered") return "Open";
  if (["result_logged", "sheet_marked_done", "winner_found", "no_clear"].includes(run.status)) return "Sheet logged";
  return titleCase(run.queueStatus || run.status || "row");
}

function formatSuggestion(suggestion) {
  if (!suggestion) return "";
  const row = suggestion.rowNumber ? `row ${suggestion.rowNumber}` : "sheet row";
  return `${suggestion.channel || "Unknown"} · ${titleCase(suggestion.testType || "test")} · ${row}`;
}

function dateOnlyText(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function connectorSummary(items = []) {
  const active = items.filter((item) => item.active);
  if (!active.length) return "not connected";
  const channels = new Set(active.flatMap((item) => item.channels || []));
  return `${channels.size} channel${channels.size === 1 ? "" : "s"} checked recently`;
}

function latestExtensionScanReceipt(items = []) {
  const receipts = items
    .map((item) => ({
      connector: item,
      scan: item.payload?.lastStudioScan || null
    }))
    .filter((item) => item.scan?.checkedAt);
  if (!receipts.length) return null;
  return receipts.sort((a, b) => new Date(b.scan.checkedAt).valueOf() - new Date(a.scan.checkedAt).valueOf())[0];
}

function buildConnectorCoverage({ connectorConfig, connectorStatus, runs, selectedChannel }) {
  const channels = coverageChannelNames({ connectorConfig, runs, selectedChannel });
  const activeStatuses = connectorStatus.filter((item) => item.active);
  const openUrls = activeStatuses.flatMap((item) => item.payload?.studioTabUrls || []).filter(Boolean);
  const openTabs = activeStatuses.flatMap((item) => item.payload?.studioTabs || []).filter(Boolean);
  const latestVersion = connectorConfig?.latestExtensionVersion || "";
  const hasCurrentVersion = Boolean(
    latestVersion && activeStatuses.some((item) => !isOlderVersion(item.version || "", latestVersion))
  );
  const outdated = hasCurrentVersion
    ? []
    : activeStatuses
        .map((item) => item.version || "")
        .filter((version) => latestVersion && isOlderVersion(version, latestVersion));
  const wrongStudioTabOpen = Boolean(
    openUrls.length &&
      connectorConfig?.watcherTabs?.length &&
      !connectorConfig.watcherTabs.some((tab) =>
        openUrls.some((url) => sameStudioTarget(url, tab.url)) ||
        openTabs.some((openTab) => sameChannel(openTab.channel, tab.label))
      )
  );
  const statuses = channels.map((channel) => {
    if (!connectorConfig?.configured) {
      return {
        channel,
        state: "missing",
        label: "Not configured"
      };
    }
    const watcher = findWatcherForChannel(channel, connectorConfig?.watcherTabs || []);
    const hasOpenWatcher = watcher?.url
      ? openUrls.some((url) => sameStudioTarget(url, watcher.url)) ||
        openTabs.some((openTab) => sameChannel(openTab.channel, channel) || sameChannel(openTab.channel, watcher.label))
      : openTabs.some((openTab) => sameChannel(openTab.channel, channel));
    const channelStatus = activeStatuses.find((item) =>
      (item.channels || []).some((candidate) => sameChannel(candidate, channel))
    );
    const hasHeartbeat = Boolean(channelStatus);
    const scanFresh = isFreshExtensionScan(channelStatus?.payload?.lastStudioScan?.checkedAt);
    if (hasOpenWatcher) {
      if (!scanFresh) return { channel, state: "heartbeat", label: "Scan stale" };
      return { channel, state: "watching", label: "Watching" };
    }
    if (hasHeartbeat) {
      return { channel, state: "heartbeat", label: "Open Studio tab needed" };
    }
    return { channel, state: "missing", label: "Extension not connected" };
  });

  const watching = statuses.filter((item) => item.state === "watching").length;
  const heartbeatOnly = statuses.filter((item) => item.state === "heartbeat").length;
  const missing = statuses.filter((item) => item.state === "missing").length;

  if (!connectorConfig?.configured) {
    return {
      tone: "danger",
      title: "Extension setup needed",
      message: "Scan can still read Sheets and YouTube, but Studio finish notifications will not be captured.",
      channels: statuses
    };
  }
  if (!activeStatuses.length) {
    return {
      tone: "danger",
      title: "Extension is not connected",
      message: "Scan can still run, but real Studio finish notifications will not be captured until the extension checks in.",
      channels: statuses
    };
  }
  if (missing || heartbeatOnly) {
    return {
      tone: "warn",
      title: wrongStudioTabOpen ? "Studio tab is open, but not a watched channel" : "Some channels need an open Studio tab",
      message:
        wrongStudioTabOpen
          ? "Open the watched channels from the extension so real finish notifications are captured for the right channels."
          : "Scan will still update sheet and YouTube data, but channels without an open Studio tab may miss real finish notifications.",
      versionWarning: outdated.length
        ? `Extension update available. Active version ${outdated[0]}, latest ${latestVersion}.`
        : "",
      channels: statuses
    };
  }
  return {
    tone: "ok",
    title: "Extension is watching selected channels",
    message: `${watching} channel${watching === 1 ? " is" : "s are"} connected with an open Studio watcher.`,
    versionWarning: outdated.length
      ? `Extension update available. Active version ${outdated[0]}, latest ${latestVersion}.`
      : "",
    channels: statuses
  };
}

function isOlderVersion(current, latest) {
  const a = String(current || "0").split(".").map((item) => Number(item) || 0);
  const b = String(latest || "0").split(".").map((item) => Number(item) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) < (b[index] || 0)) return true;
    if ((a[index] || 0) > (b[index] || 0)) return false;
  }
  return false;
}

function isFreshExtensionScan(value) {
  if (!value) return false;
  const time = new Date(value).valueOf();
  if (!Number.isFinite(time)) return false;
  return Date.now() - time < 2 * 60 * 60 * 1000;
}

function coverageChannelNames({ connectorConfig, runs, selectedChannel }) {
  if (selectedChannel && selectedChannel !== "all") return [selectedChannel];
  const names = new Set();
  for (const channel of connectorConfig?.channels || []) {
    if (channel) names.add(displayChannel(channel));
  }
  for (const tab of connectorConfig?.watcherTabs || []) {
    if (tab.label) names.add(displayChannel(tab.label));
  }
  for (const run of runs || []) {
    const channel = displayChannel(run);
    if (isPriorityChannel(channel)) names.add(channel);
  }
  return Array.from(names).filter(Boolean).sort(compareChannels);
}

function findWatcherForChannel(channel, watcherTabs) {
  return watcherTabs.find((tab) => sameChannel(tab.label, channel)) || null;
}

function sameStudioTarget(openUrl, watcherUrl) {
  const open = String(openUrl || "").replace(/\/+$/, "");
  const watcher = String(watcherUrl || "").replace(/\/+$/, "");
  const watcherChannelId = watcher.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  if (watcherChannelId) return open.includes(watcherChannelId);
  return watcher ? open.startsWith(watcher) : false;
}

function sameChannel(a, b) {
  return normalizeText(displayChannel(a)) === normalizeText(displayChannel(b));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function daysSince(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return NaN;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today - date) / 86400000);
}

function channelHue(value) {
  const text = String(value || "channel");
  let hash = 0;
  for (let idx = 0; idx < text.length; idx += 1) {
    hash = (hash * 31 + text.charCodeAt(idx)) % 360;
  }
  return hash;
}

function channelAccent(value) {
  const channel = displayChannel(value);
  if (CHANNEL_ACCENTS.has(channel)) return CHANNEL_ACCENTS.get(channel);
  const index = Math.abs(channelHue(channel)) % DEFAULT_CHANNEL_ACCENTS.length;
  return DEFAULT_CHANNEL_ACCENTS[index];
}

function scanChipStyle(channel) {
  if (!channel || channel === "all") {
    return { "--scan-accent": "var(--muted)" };
  }
  return { "--scan-accent": channelAccent(channel) };
}

function channelInitials(value) {
  const words = String(value || "Unknown")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function formatShare(value) {
  if (typeof value === "number") return `${(value * 100).toFixed(1)}%`;
  if (value === "no_clear_winner") return "No clear winner";
  return value || "Blank";
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function scanButtonLabel(channel, type, fallback = "Scan Now") {
  const channelPart = Array.isArray(channel)
    ? channel.length === 1
      ? channel[0]
      : channel.length > 1
        ? `${channel.length} channels`
        : ""
    : channel !== "all"
      ? channel
      : "";
  const parts = [
    channelPart,
    type !== "all" ? titleCase(type) : ""
  ].filter(Boolean);
  return parts.length ? `Scan ${parts.join(" · ")}` : fallback;
}

function timingLabel(key) {
  const labels = {
    prepare: "Prepare",
    read_title: "Read titles",
    read_thumbnail: "Read thumbnails",
    thumbnail_export: "Thumbnail export",
    thumbnail_import: "Thumbnail import",
    thumbnail_map: "Thumbnail map",
    youtube_metadata: "YouTube data",
    save_runs: "Save results",
    finish_signals: "Finish signals",
    flag_missing: "Missing rows",
    refresh_queue: "Refresh queue"
  };
  return labels[key] || titleCase(key);
}

function formatDuration(value) {
  const ms = Number(value) || 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatDateTimeWithExactAge(value) {
  return `${formatDateTime(value)} · ${exactDaysAgo(value)}`;
}

function formatDateWithExactAge(value) {
  return `${value} · ${exactDaysAgo(`${value}T00:00:00`)}`;
}

function exactDaysAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "unknown age";
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function normalizeNotificationAgeLabel(value) {
  const rawValue = typeof value === "object" && value
    ? value.label || (Number.isFinite(Number(value.days)) ? `${Number(value.days)} days ago` : "")
    : value;
  const text = String(rawValue || "").trim().toLowerCase();
  const match = text.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/);
  if (!match) return text || "";
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "day") return `${amount} day${amount === 1 ? "" : "s"} ago`;
  if (unit === "week") {
    const days = amount * 7;
    return `${days} days ago`;
  }
  if (unit === "month") {
    const days = amount * 30;
    return `${days} days ago`;
  }
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

function isBridgeOfflineMessage(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("bridge offline") || text.includes("did not respond from this dashboard page");
}

function requestExtension(type, { timeoutMs = 12000 } = {}) {
  if (typeof window === "undefined") return Promise.reject(new Error("Browser extension bridge is unavailable."));
  const requestId = `ytab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Extension bridge offline."));
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window) return;
      const message = event.data || {};
      if (message.source !== "youtube-ab-tests-extension" || message.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(message.response || {});
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "youtube-ab-tests-app", type, requestId }, window.location.origin);
  });
}

function extensionCommandLoadingText(type) {
  if (type === "open-notification-page") return "Opening or reusing YouTube home for a bell check...";
  if (type === "report-missed-notification") return "Sending a debug snapshot from the extension...";
  return "Asking the Chrome extension to scan open Studio tabs and the YouTube bell menu...";
}

function extensionScanSummary(response) {
  const tabs = Array.isArray(response.tabs) ? response.tabs : [];
  const totals = tabs.reduce(
    (summary, tab) => {
      summary.tabs += 1;
      summary.candidates += Number(tab.candidates || 0);
      summary.received += Number(tab.received || 0);
      summary.matched += Number(tab.matched || 0);
      summary.unmatched += Number(tab.unmatched || 0);
      return summary;
    },
    { tabs: 0, candidates: 0, received: 0, matched: 0, unmatched: 0 }
  );
  if (!totals.tabs) return "No Studio or YouTube bell tabs were open.";
  if (!totals.received) return `Checked ${totals.tabs} tab${totals.tabs === 1 ? "" : "s"}; no finish notification text was captured.`;
  return `Sent ${totals.received} signal${totals.received === 1 ? "" : "s"}: ${totals.matched} matched, ${totals.unmatched} unregistered.`;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard?.writeText(value);
}

function notifyBrowser(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body });
}
