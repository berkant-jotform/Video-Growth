"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

const SECTION_ORDER = [
  "needs_review",
  "sheet_changed_after_done",
  "missing_data"
];

const SECTION_LABELS = {
  needs_review: "Newly Finished",
  sheet_changed_after_done: "Sheet Changed After Done",
  missing_data: "Missing Data",
  result_logged: "Already Logged in Sheet",
  sheet_marked_done: "Marked Done in Sheet",
  running: "Running"
};

const ACTIONS = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
  { value: "NO_CLEAR", label: "No Clear" },
  { value: "KEPT_CURRENT", label: "Kept Current" },
  { value: "RETEST_LATER", label: "Retest Later" },
  { value: "SKIP", label: "Skip" }
];

export default function DetectorPage({ session }) {
  const [runs, setRuns] = useState([]);
  const [summary, setSummary] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [modalRun, setModalRun] = useState(null);
  const [channel, setChannel] = useState("all");
  const [type, setType] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [finishWindow, setFinishWindow] = useState("all");
  const [retestFilter, setRetestFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedStatus, setAdvancedStatus] = useState("all");

  useEffect(() => {
    refresh();
  }, []);

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
      setSummary(queuePayload.summary || null);
      setLastScan(statusPayload.lastScan || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function scanNow() {
    setScanning(true);
    setError("");
    try {
      const response = await fetch("/api/scan", { method: "POST" });
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

  const channels = useMemo(
    () => ["all", ...Array.from(new Set(runs.map((run) => run.channel).filter(Boolean))).sort()],
    [runs]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return runs.filter((run) => {
      if (channel !== "all" && run.channel !== channel) return false;
      if (type !== "all" && run.testType !== type) return false;
      if (resultFilter !== "all" && cardResult(run).key !== resultFilter) return false;
      if (finishWindow !== "all" && !matchesFinishWindow(run, finishWindow)) return false;
      if (retestFilter === "only" && !run.possibleRetest) return false;
      if (retestFilter === "hide" && run.possibleRetest) return false;
      if (advancedStatus !== "all" && statusKey(run) !== advancedStatus) return false;
      if (query) {
        const haystack = `${run.videoTitle} ${run.channel} ${run.videoId} ${run.suggestedWinner}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [runs, channel, type, resultFilter, finishWindow, retestFilter, advancedStatus, search]);

  const grouped = useMemo(() => groupRuns(filtered), [filtered]);

  return (
    <AppShell session={session} active="detector">
      <main className="workspace">
        <section className="hero-row">
          <div>
            <p className="eyebrow">Shared team queue</p>
            <h2>Newly finished tests to check in Studio</h2>
            <p className="muted">
              Last scan: {lastScan?.completedAt ? formatDateTime(lastScan.completedAt) : "No scan yet"}
            </p>
          </div>
          <button className="primary-button scan-button" onClick={scanNow} disabled={scanning}>
            <RefreshCw size={18} className={scanning ? "spin" : ""} />
            {scanning ? "Scanning" : "Scan Now"}
          </button>
        </section>

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
          <label>
            Result
            <select value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}>
              <option value="all">All results</option>
              <option value="not_determined">Not determined</option>
              <option value="missing_data">Cannot determine</option>
              <option value="sheet_changed">Changed after done</option>
              <option value="winner">Winner known</option>
              <option value="no_clear">No clear</option>
            </select>
          </label>
          <label>
            Finished
            <select value={finishWindow} onChange={(event) => setFinishWindow(event.target.value)}>
              <option value="all">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="older">Older than 30 days</option>
              <option value="missing">Missing date</option>
            </select>
          </label>
          <label className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search video, ID, channel"
            />
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

        <section className="channel-list">
          {grouped.map((group) => (
            <ChannelGroup
              key={group.channel}
              group={group}
              onDetails={setSelected}
              onDone={setModalRun}
            />
          ))}
        </section>
      </main>
      {selected ? <DetailDrawer run={selected} onClose={() => setSelected(null)} /> : null}
      {modalRun ? (
        <DoneModal
          run={modalRun}
          onClose={() => setModalRun(null)}
          onDone={async () => {
            setModalRun(null);
            await refresh();
          }}
        />
      ) : null}
    </AppShell>
  );
}

function Summary({ summary }) {
  const items = [
    ["Newly Finished", summary?.newlyFinished || 0],
    ["Missing", summary?.missingData || 0],
    ["Changed", summary?.sheetChangedAfterDone || 0],
    ["Retests", summary?.possibleRetest || 0],
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

function ChannelGroup({ group, onDetails, onDone }) {
  return (
    <section className="channel-group">
      <div className="channel-heading">
        <h3>{group.channel}</h3>
        <span>{group.count} active</span>
      </div>
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
                <TestCard run={run} key={run.testRunId} onDetails={onDetails} onDone={onDone} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function TestCard({ run, onDetails, onDone }) {
  const result = cardResult(run);
  return (
    <article
      className={`test-card ${statusKey(run)}`}
      style={{ "--channel-hue": channelHue(run.channel) }}
    >
      <div className="card-topline">
        <span className="channel-pill">{run.channel || "Unknown channel"}</span>
        <span className="date-pill">{run.effectiveFinishDate || "No finish date"}</span>
      </div>
      <div className="card-badges">
        <span className="type-pill">{titleCase(run.testType)} test</span>
        <span className={`result-pill ${result.tone}`}>{result.label}</span>
      </div>
      <CardVisual run={run} result={result} />
      <h4>{run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video"}</h4>
      <div className="card-meta-grid">
        <div>
          <span>Channel</span>
          <strong>{run.channel || "Unknown"}</strong>
        </div>
        <div>
          <span>Result</span>
          <strong>{result.value}</strong>
        </div>
      </div>
      <p className="outcome">{outcomeLabel(run)}</p>
      {run.possibleRetest ? <span className="badge warning">Possible Retest</span> : null}
      {run.testType === "thumbnail" ? <ThumbnailStrip previews={run.thumbnailPreviews} /> : null}
      <div className="card-actions">
        <a className="studio-button" href={run.studioUrl || "#"} target="_blank" rel="noreferrer">
          <ExternalLink size={18} />
          Open Studio
        </a>
        <button className="icon-button" title="Copy video ID" onClick={() => copyText(run.videoId)}>
          <Clipboard size={17} />
        </button>
        <button className="secondary-button" onClick={() => onDetails(run)}>
          Details
        </button>
        <button className="done-button" onClick={() => onDone(run)}>
          <Check size={17} />
          Done
        </button>
      </div>
    </article>
  );
}

function CardVisual({ run, result }) {
  const preview = firstThumbnailPreview(run.thumbnailPreviews);
  const imageUrl = preview || run.currentYoutubeThumbnailUrl;
  if (imageUrl) {
    return (
      <div className="card-visual has-image">
        <img src={imageUrl} alt="" />
        <span>{preview ? "Sheet preview" : "Current YouTube thumbnail"}</span>
      </div>
    );
  }
  return (
    <div className="card-visual visual-placeholder">
      <span>{result.label}</span>
      <strong>{channelInitials(run.channel)}</strong>
      <em>{titleCase(run.testType)} test</em>
    </div>
  );
}

function ThumbnailStrip({ previews }) {
  const keys = ["A", "B", "C"].filter((key) => previews?.[key]);
  if (!keys.length) return <div className="thumbnail-missing">Thumbnail preview missing</div>;
  return (
    <div className="thumbnail-strip">
      {keys.map((key) => (
        <figure key={key}>
          <img src={previews[key]} alt={`Thumbnail ${key}`} />
          <figcaption>{key}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function DetailDrawer({ run, onClose }) {
  return (
    <aside className="drawer">
      <button className="icon-button drawer-close" onClick={onClose} title="Close details">
        <X size={18} />
      </button>
      <p className="eyebrow">{run.channel}</p>
      <h2>{run.videoTitle || run.currentYoutubeTitle || run.videoId}</h2>
      <div className="detail-status">
        <span className={`badge ${statusKey(run)}`}>{SECTION_LABELS[statusKey(run)] || titleCase(statusKey(run))}</span>
        {run.suggestedWinner ? <strong>{run.suggestedWinner}</strong> : null}
      </div>
      <a className="studio-button wide" href={run.studioUrl || "#"} target="_blank" rel="noreferrer">
        <ExternalLink size={18} />
        Open Studio
      </a>
      <div className="detail-grid">
        <Info label="Video ID" value={run.videoId || "Missing"} />
        <Info label="Source row" value={`${run.sheetName} row ${run.rowNumber}`} />
        <Info label="Start" value={run.startDate || "Missing"} />
        <Info label="Finish" value={run.effectiveFinishDate || "Missing"} />
      </div>
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

function DoneModal({ run, onClose, onDone }) {
  const [action, setAction] = useState(run.suggestedWinner?.match(/^[ABC]$/) ? run.suggestedWinner : "");
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

function groupRuns(runs) {
  const map = new Map();
  for (const run of runs) {
    const channel = run.channel || "Unknown channel";
    if (!map.has(channel)) map.set(channel, { channel, count: 0, sections: {} });
    const group = map.get(channel);
    group.count += 1;
    const key = statusKey(run);
    group.sections[key] ||= [];
    group.sections[key].push(run);
  }
  return Array.from(map.values()).sort((a, b) => a.channel.localeCompare(b.channel));
}

function statusKey(run) {
  return run.queueStatus || run.status || "needs_review";
}

function outcomeLabel(run) {
  if (run.queueStatus === "sheet_changed_after_done") return "Sheet changed after this was done";
  if (run.status === "result_logged") return "Result already entered in sheet";
  if (run.status === "sheet_marked_done") return "Marked done in sheet";
  if (run.status === "needs_review") return "Finished by date; result not logged yet";
  if (run.status === "missing_data") return "Missing source data";
  return run.winnerReason || titleCase(run.status);
}

function cardResult(run) {
  if (run.queueStatus === "sheet_changed_after_done") {
    return { key: "sheet_changed", label: "Recheck", value: "Sheet changed", tone: "warning" };
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

function firstThumbnailPreview(previews) {
  return ["A", "B", "C"].map((key) => previews?.[key]).find(Boolean) || "";
}

function matchesFinishWindow(run, windowValue) {
  if (windowValue === "missing") return !run.effectiveFinishDate;
  if (!run.effectiveFinishDate) return false;
  const days = daysSince(run.effectiveFinishDate);
  if (!Number.isFinite(days)) return false;
  if (windowValue === "older") return days > 30;
  return days >= 0 && days <= Number(windowValue);
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

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard?.writeText(value);
}

function notifyBrowser(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body });
}
