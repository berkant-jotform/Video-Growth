"use client";

import { useEffect, useMemo, useState } from "react";
import {
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
  "confirmed_finished",
  "applied_change_observed",
  "past_due_check",
  "uncovered",
  "watching",
  "sheet_changed_after_done",
  "missing_data"
];

const SECTION_LABELS = {
  confirmed_finished: "Confirmed Finished",
  applied_change_observed: "Applied Change Observed",
  past_due_check: "Past 14 Days - Check Studio",
  uncovered: "Needs Signal",
  watching: "Watching",
  needs_review: "Explicit Sheet Finish",
  sheet_changed_after_done: "Sheet Changed After Done",
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

export default function DetectorPage({ session }) {
  const [runs, setRuns] = useState([]);
  const [unmatchedEvents, setUnmatchedEvents] = useState([]);
  const [connectorStatus, setConnectorStatus] = useState([]);
  const [connectorConfig, setConnectorConfig] = useState({ configured: false, channels: [], watcherTabs: [] });
  const [summary, setSummary] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [modalRun, setModalRun] = useState(null);
  const [modalInitialAction, setModalInitialAction] = useState("");
  const [quickSaving, setQuickSaving] = useState("");
  const [channel, setChannel] = useState("all");
  const [type, setType] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [finishWindow, setFinishWindow] = useState("all");
  const [retestFilter, setRetestFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedStatus, setAdvancedStatus] = useState("all");
  const [openedStudioRuns, setOpenedStudioRuns] = useState(() => new Set());

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(OPENED_STUDIO_STORAGE_KEY);
      if (stored) setOpenedStudioRuns(new Set(JSON.parse(stored)));
    } catch {
      setOpenedStudioRuns(new Set());
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
      setScanProgress(payload.lastScan?.progress || null);
      setConnectorStatus(payload.connectorStatus || []);
      setConnectorConfig(payload.connector || { configured: false, channels: [], watcherTabs: [] });
    } catch {
      // Progress polling is best-effort; the main scan request still reports failures.
    }
  }

  async function scanNow() {
    const scoped = {
      channel: channel !== "all" ? channel : "all",
      testType: type !== "all" ? type : "all"
    };
    const scopedText = [
      scoped.channel !== "all" ? scoped.channel : "",
      scoped.testType !== "all" ? `${titleCase(scoped.testType)} tests` : ""
    ].filter(Boolean).join(" · ");
    setScanning(true);
    setError("");
    setScanProgress({
      stage: "starting",
      label: "Starting scan",
      detail: scopedText ? `Scanning only ${scopedText}.` : "Preparing sheet and YouTube checks.",
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

  async function quickComplete(run, action) {
    if (run.possibleRetest) {
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
        window.localStorage.setItem(OPENED_STUDIO_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // Local visual state is helpful but non-critical.
      }
      return next;
    });
  }

  const channels = useMemo(
    () => [
      "all",
      ...Array.from(new Set(runs.map((run) => displayChannel(run)).filter(Boolean))).sort(compareChannels)
    ],
    [runs]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return runs.filter((run) => {
      const runChannel = displayChannel(run);
      if (channel !== "all" && runChannel !== channel) return false;
      if (type !== "all" && run.testType !== type) return false;
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
  }, [runs, channel, type, resultFilter, finishWindow, retestFilter, advancedStatus, search]);

  const grouped = useMemo(
    () => groupRuns(filtered, { groupOtherChannels: channel === "all" }),
    [filtered, channel]
  );

  return (
    <AppShell session={session} active="detector">
      <main className="workspace">
        <section className="hero-row">
          <div>
            <p className="eyebrow">Shared team queue</p>
            <h2>Real finish tracker</h2>
            <p className="muted">
              Last sheet scan: {lastScan?.completedAt ? formatDateTime(lastScan.completedAt) : "No scan yet"}.
              Connector: {connectorSummary(connectorStatus)}
            </p>
          </div>
          <div className="scan-scope-panel">
            <div className="scan-scope-fields">
              <label>
                Scan channel
                <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  {channels.map((item) => (
                    <option key={item} value={item}>
                      {item === "all" ? "All channels" : item}
                    </option>
                  ))}
                </select>
              </label>
              <div className="filter-control scan-type-control">
                <span className="filter-label">Scan type</span>
                <div className="segmented" aria-label="Scan type">
                  {["all", "title", "thumbnail"].map((item) => (
                    <button
                      key={item}
                      className={type === item ? "active" : ""}
                      onClick={() => setType(item)}
                      type="button"
                    >
                      {item === "all" ? "All" : titleCase(item)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <button className="primary-button scan-button" onClick={scanNow} disabled={scanning}>
              <RefreshCw size={18} className={scanning ? "spin" : ""} />
              {scanning ? "Scanning" : scanButtonLabel(channel, type)}
            </button>
          </div>
        </section>

        <ConnectorCoveragePanel
          connectorConfig={connectorConfig}
          connectorStatus={connectorStatus}
          runs={runs}
          selectedChannel={channel}
        />

        <ScanProgress scan={lastScan} progress={scanProgress} scanning={scanning} />

        <Summary summary={summary} />

        <section className="filters">
          <label>
            Channel
            <select value={channel} onChange={(event) => setChannel(event.target.value)}>
              {channels.map((item) => (
                <option key={item} value={item}>
                  {item === "all" ? "All channels" : item}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-control test-type-control">
            <span className="filter-label">Test type</span>
            <div className="segmented" aria-label="Test type">
              {["all", "title", "thumbnail"].map((item) => (
                <button
                  key={item}
                  className={type === item ? "active" : ""}
                  onClick={() => setType(item)}
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
              <option value="confirmed">Confirmed finished</option>
              <option value="observed">Applied change observed</option>
              <option value="past_due_check">Past 14 days</option>
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
          <UnmatchedEvents events={unmatchedEvents} />
        ) : null}

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
              quickSaving={quickSaving}
              openedStudioRuns={openedStudioRuns}
              onStudioOpen={markStudioOpened}
            />
          ))}
        </section>
      </main>
      {selected ? (
        <DetailDrawer
          run={selected}
          onClose={() => setSelected(null)}
          opened={openedStudioRuns.has(selected.testRunId)}
          onStudioOpen={markStudioOpened}
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
    ["Confirmed", summary?.confirmedFinished || summary?.newlyFinished || 0],
    ["Observed", summary?.appliedChangeObserved || 0],
    ["Past 14d", summary?.pastDueCheck || 0],
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

function ScanProgress({ scan, progress, scanning }) {
  if (!scanning && scan?.status !== "running") return null;
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
    <section className="scan-progress-panel">
      <div className="scan-progress-header">
        <div>
          <span className="eyebrow">Scan progress</span>
          <h3>{progress?.label || "Scanning"}</h3>
          <p>{progress?.detail || "Working through sheets, thumbnails, YouTube data, and finish signals."}</p>
        </div>
        <strong>{percent}%</strong>
      </div>
      <div className="scan-progress-track" aria-label="Scan progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      {steps.length ? (
        <div className="scan-step-list">
          {steps.map((step) => (
            <span className={`scan-step ${step.state}`} key={step.stage}>
              {step.label}
            </span>
          ))}
        </div>
      ) : null}
      {countItems.length ? (
        <div className="scan-count-list">
          {countItems.map(([label, value]) => (
            <span key={label}>
              {label}: <strong>{value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {timingItems.length ? (
        <div className="scan-timing-list">
          {timingItems.map(([key, value]) => (
            <span key={key}>
              {timingLabel(key)}: <strong>{formatDuration(value)}</strong>
            </span>
          ))}
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

function UnmatchedEvents({ events }) {
  return (
    <section className="unmatched-events">
      <div className="section-title">
        <span>Unmatched Studio Events</span>
        <span>{events.length}</span>
      </div>
      <div className="unmatched-list">
        {events.slice(0, 6).map((event) => (
          <article className="unmatched-event" key={event.eventId}>
            <div>
              <strong>{event.channel || event.videoId || "Unknown source"}</strong>
              <span className="event-source-line">
                Source: {eventSourceLabel(event.source)} · Not matched to an active sheet row
                {event.videoId ? ` · Video ${event.videoId}` : ""}
              </span>
              <p>{event.rawText || "Studio notification captured without text."}</p>
              {event.notificationUrl ? (
                <a href={event.notificationUrl} target="_blank" rel="noreferrer">
                  Open Studio page
                </a>
              ) : null}
            </div>
            <span>{event.observedAt ? formatDateTime(event.observedAt) : "No time"}</span>
          </article>
        ))}
      </div>
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

function ChannelGroup({ group, onDetails, onDone, onQuickAction, quickSaving, openedStudioRuns, onStudioOpen }) {
  return (
    <section
      className="channel-group"
      style={{ "--channel-hue": channelHue(group.channel), "--channel-accent": channelAccent(group.channel) }}
    >
      <div className="channel-heading">
        <div className="channel-heading-main">
          <ChannelAvatar channel={group.channel} logoUrl={group.channelLogoUrl} size="large" />
          <h3>{group.channel}</h3>
        </div>
        <span>{group.count} active</span>
      </div>
      {group.channelCount > 1 ? (
        <p className="channel-group-note">{group.channelCount} lower-volume channels grouped here.</p>
      ) : null}
      {SECTION_ORDER.map((section) => {
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

function TestCard({ run, onDetails, onDone, onQuickAction, quickSaving, opened, onStudioOpen }) {
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
      <div className="card-meta-grid">
        <div className="channel-meta">
          <span>Channel</span>
          <strong>{channel || "Unknown"}</strong>
        </div>
        <div>
          <span>Source</span>
          <strong>{result.value}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{testDurationLabel(run)}</strong>
        </div>
      </div>
      <p className="outcome">{outcomeLabel(run)}</p>
      {run.possibleRetest ? <span className="badge warning">Possible Retest</span> : null}
      <div className="card-actions">
        <a
          className={`studio-button${opened ? " opened" : ""}`}
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

function DetailDrawer({ run, onClose, opened, onStudioOpen }) {
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
        <Info label="Source row" value={`${run.sheetName} row ${run.rowNumber}`} />
        <Info label="Signal" value={signalSourceLabel(run)} />
        <Info label="Test lasted" value={testDurationLabel(run)} />
        <Info label="Coverage" value={run.connectorCovered ? `Covered by ${run.connectorActorName || "connector"}` : "No active connector"} />
        <Info label="Start" value={run.startDate || "Missing"} />
        <Info label="Sheet finish" value={run.effectiveFinishDate || "Blank"} />
      </div>
      {run.finishEventText ? (
        <section className="drawer-section">
          <h3>Finish Signal</h3>
          <p>{run.finishEventText}</p>
          <p className="muted">
            {signalSourceLabel(run)} · {run.finishEventAt ? formatDateTime(run.finishEventAt) : "No timestamp"} · {run.matchedConfidence || "matched"}
          </p>
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
  const [retestConfirmed, setRetestConfirmed] = useState(!run.possibleRetest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!action) {
      setError("Choose the outcome.");
      return;
    }
    if (run.possibleRetest && !retestConfirmed) {
      setError("Confirm this is a separate retest run.");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/actions/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testRunId: run.testRunId, action, retestConfirmed })
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
        {run.possibleRetest ? (
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
  return Array.from(map.values())
    .map((group) => ({ ...group, channelCount: group.originalChannels.size }))
    .sort(compareGroups);
}

function displayChannel(runOrChannel) {
  const raw = typeof runOrChannel === "string" ? runOrChannel : runOrChannel?.channel;
  return canonicalChannelName(raw) || raw || "";
}

function isPriorityChannel(channel) {
  const canonical = displayChannel(channel);
  return CHANNEL_PRIORITY.includes(canonical);
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
  if (filter === "confirmed") return run.queueStatus === "confirmed_finished";
  if (filter === "observed") return run.queueStatus === "applied_change_observed";
  if (filter === "past_due_check") return run.queueStatus === "past_due_check";
  if (filter === "watching") return run.queueStatus === "watching";
  if (filter === "uncovered") return run.queueStatus === "uncovered";
  return cardResult(run).key === filter;
}

function outcomeLabel(run) {
  if (run.queueStatus === "sheet_changed_after_done") return "Sheet changed after this was done";
  if (run.queueStatus === "confirmed_finished") {
    if (run.finishEventSource === "studio_bell") return "Studio notification confirmed this test finished";
    if (run.finishEventSource === "studio_page_status") return "Studio edit page says this test finished";
    return "Explicit sheet finish/result signal";
  }
  if (run.queueStatus === "applied_change_observed") return "Visible YouTube metadata changed to a B/C option";
  if (run.queueStatus === "past_due_check") return "Past 14 days with no real finish signal; open Studio to verify";
  if (run.queueStatus === "uncovered") return "No active Studio connector is watching this channel";
  if (run.queueStatus === "watching") return "Active test; no real finish signal yet";
  if (run.status === "result_logged") return "Result already entered in sheet";
  if (run.status === "sheet_marked_done") return "Marked done in sheet";
  if (run.status === "missing_data") return "Missing source data";
  return run.winnerReason || titleCase(run.status);
}

function cardResult(run) {
  if (run.queueStatus === "sheet_changed_after_done") {
    return { key: "sheet_changed", label: "Recheck", value: "Sheet changed", tone: "warning" };
  }
  if (run.queueStatus === "confirmed_finished") {
    const detected = detectedOutcomeLabel(run.finishEventOutcome || run.detectedOutcome);
    return {
      key: detected.key === "winner" ? "winner" : detected.key === "no_clear" ? "no_clear" : "confirmed",
      label: detected.label || "Confirmed",
      value: signalSourceLabel(run),
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
    return { key: "past_due_check", label: "Check Studio", value: "Past 14 days", tone: "warning" };
  }
  if (run.queueStatus === "uncovered") {
    return { key: "uncovered", label: "Needs signal", value: "No connector", tone: "warning" };
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
    return { key: "no_clear", label: "No clear", value: "Not enough impressions", tone: "warning" };
  }
  if (run.status === "result_logged") {
    return { key: "logged", label: "Logged", value: "Already in sheet", tone: "neutral" };
  }
  if (run.status === "sheet_marked_done") {
    return { key: "logged", label: "Done", value: "Marked in sheet", tone: "neutral" };
  }
  return { key: "not_determined", label: "Not determined", value: "Review in Studio", tone: "neutral" };
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

function signalDateLabel(run) {
  if (run.finishEventAt) return formatDateTime(run.finishEventAt);
  if (run.queueStatus === "past_due_check") return "Past 14 days";
  if (run.effectiveFinishDate) return `Sheet ${run.effectiveFinishDate}`;
  return "No signal yet";
}

function signalSourceLabel(run) {
  if (run.finishEventSource === "studio_bell") return "Studio extension";
  if (run.finishEventSource === "studio_page_status") return "Studio page status";
  if (run.finishEventSource === "metadata") return "Metadata observed";
  if (run.queueStatus === "past_due_check") return "Date fallback";
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

function dateOnlyText(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function connectorSummary(items = []) {
  const active = items.filter((item) => item.active);
  if (!active.length) return "no active extension heartbeat";
  const channels = new Set(active.flatMap((item) => item.channels || []));
  return `${active.length} active extension${active.length === 1 ? "" : "s"} watching ${channels.size} channel${channels.size === 1 ? "" : "s"}`;
}

function buildConnectorCoverage({ connectorConfig, connectorStatus, runs, selectedChannel }) {
  const channels = coverageChannelNames({ connectorConfig, runs, selectedChannel });
  const activeStatuses = connectorStatus.filter((item) => item.active);
  const openUrls = activeStatuses.flatMap((item) => item.payload?.studioTabUrls || []).filter(Boolean);
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
      !connectorConfig.watcherTabs.some((tab) => openUrls.some((url) => sameStudioTarget(url, tab.url)))
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
    const hasOpenWatcher = watcher?.url ? openUrls.some((url) => sameStudioTarget(url, watcher.url)) : false;
    const hasHeartbeat = activeStatuses.some((item) =>
      (item.channels || []).some((candidate) => sameChannel(candidate, channel))
    );
    if (hasOpenWatcher) {
      return { channel, state: "watching", label: "Watching" };
    }
    if (hasHeartbeat) {
      return { channel, state: "heartbeat", label: "Heartbeat only" };
    }
    return { channel, state: "missing", label: "Not connected" };
  });

  const watching = statuses.filter((item) => item.state === "watching").length;
  const heartbeatOnly = statuses.filter((item) => item.state === "heartbeat").length;
  const missing = statuses.filter((item) => item.state === "missing").length;

  if (!connectorConfig?.configured) {
    return {
      tone: "danger",
      title: "Extension connector is not configured",
      message: "Scan can still read Sheets and YouTube, but Studio finish notifications will not be captured.",
      channels: statuses
    };
  }
  if (!activeStatuses.length) {
    return {
      tone: "danger",
      title: "Extension is not connected",
      message: "Scan can still run, but every channel is blind to real Studio finish notifications until the extension sends heartbeat.",
      channels: statuses
    };
  }
  if (missing || heartbeatOnly) {
    return {
      tone: "warn",
      title: wrongStudioTabOpen ? "Studio tab is open, but not a watcher channel" : "Some channels are not actively watched",
      message:
        wrongStudioTabOpen
          ? "Open the configured watcher tabs from the extension so real finish notifications are captured for the right channels."
          : "Scan will still update sheet and YouTube data, but channels marked heartbeat only or not connected may miss real finish notifications.",
      versionWarning: outdated.length
        ? `Extension update available. Active version ${outdated[0]}, latest ${latestVersion}.`
        : "",
      channels: statuses
    };
  }
  return {
    tone: "ok",
    title: "Extension is watching selected channels",
    message: `${watching} channel${watching === 1 ? " is" : "s are"} connected with an open Studio watcher tab.`,
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

function scanButtonLabel(channel, type) {
  const parts = [
    channel !== "all" ? channel : "",
    type !== "all" ? titleCase(type) : ""
  ].filter(Boolean);
  return parts.length ? `Scan ${parts.join(" · ")}` : "Scan Now";
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
