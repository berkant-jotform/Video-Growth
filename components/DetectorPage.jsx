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
      if (advancedStatus !== "all" && statusKey(run) !== advancedStatus) return false;
      if (query) {
        const haystack = `${run.videoTitle} ${run.channel} ${run.videoId} ${run.suggestedWinner}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [runs, channel, type, advancedStatus, search]);

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
  return (
    <article className={`test-card ${statusKey(run)}`}>
      <div className="card-topline">
        <span className="type-pill">{titleCase(run.testType)}</span>
        <span className="date-pill">{run.effectiveFinishDate || "No finish date"}</span>
      </div>
      <h4>{run.videoTitle || run.currentYoutubeTitle || run.videoId || "Untitled video"}</h4>
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
