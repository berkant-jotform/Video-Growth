"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Pencil, Search, Users, X } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

export default function HistoryPage({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [action, setAction] = useState("all");
  const [testType, setTestType] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [correcting, setCorrecting] = useState("");
  const [correction, setCorrection] = useState("A");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => load(controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  async function load(signal) {
    setError("");
    setLoading(true);
    try {
      const response = await fetch(`/api/history?q=${encodeURIComponent(search)}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "History failed.");
      setItems(payload.items || []);
    } catch (requestError) {
      if (requestError.name !== "AbortError") setError(requestError.message || "Could not load history.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  const channels = useMemo(
    () => Array.from(new Set(items.map((item) => item.channel).filter(Boolean))).sort(),
    [items]
  );
  const actions = useMemo(
    () => Array.from(new Set(items.map((item) => item.action?.action).filter(Boolean))).sort(),
    [items]
  );
  const filtered = useMemo(
    () => items.filter((item) =>
      (channel === "all" || item.channel === channel) &&
      (action === "all" || item.action?.action === action) &&
      (testType === "all" || item.testType === testType)
    ),
    [items, channel, action, testType]
  );
  const reviewerCount = useMemo(
    () => new Set(items.map((item) => item.action?.actorName).filter(Boolean)).size,
    [items]
  );

  async function saveCorrection(item) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/actions/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testRunId: item.testRunId,
          action: correction,
          retestConfirmed: true,
          note: `Corrected from History. Previous action: ${item.action?.action || "unknown"}`
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save correction.");
      setCorrecting("");
      await load();
    } catch (saveError) {
      setError(saveError.message || "Could not save correction.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell session={session} active="history">
      <main className="workspace history-workspace">
        <section className="page-intro history-intro">
          <div>
            <p className="eyebrow">Shared team record</p>
            <h2>Completed actions</h2>
            <p className="muted">Every decision made in the detector, with the reviewer and Studio link preserved.</p>
          </div>
          <div className="history-summary" aria-label="History summary">
            <span><strong>{items.length}</strong> actions</span>
            <span><strong>{reviewerCount}</strong> reviewers</span>
            <span><strong>{channels.length}</strong> channels</span>
          </div>
        </section>

        <section className="history-toolbar" aria-label="History filters">
          <label className="history-search-field">
            <span>Search</span>
            <span className="search-box history-search">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search video, ID, reviewer" />
            </span>
          </label>
          <label>
            <span>Channel</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value)}>
              <option value="all">All channels</option>
              {channels.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Outcome</span>
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="all">All outcomes</option>
              {actions.map((value) => <option key={value} value={value}>{labelAction(value)}</option>)}
            </select>
          </label>
          <div className="filter-control history-type-control">
            <span className="toolbar-field-label">Test type</span>
            <div className="segmented history-type-filter" role="group" aria-label="Test type">
              {[["all", "All"], ["title", "Title"], ["thumbnail", "Thumbnail"]].map(([value, label]) => (
                <button type="button" className={testType === value ? "active" : ""} key={value} onClick={() => setTestType(value)}>{label}</button>
              ))}
            </div>
          </div>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        <section className="history-list">
          {filtered.map((item) => (
            <article className={`history-item ${item.action.undoneAt ? "undone" : ""}`} key={`${item.action.actionId}-${item.testRunId}`}>
              <div className="history-item-main">
                <div className="history-item-meta">
                  <span className={`type-pill ${item.testType || "title"}`}>{titleCase(item.testType || "test")}</span>
                  <span>{item.channel || "Unknown channel"}</span>
                </div>
                <h3>{item.videoTitle || item.currentYoutubeTitle || item.videoId}</h3>
                <p>{item.videoId || "Video ID unavailable"}</p>
              </div>
              <div className="history-action">
                <span className={`history-outcome ${actionTone(item.action.action)}`}>
                  <CheckCircle2 size={15} />
                  {item.action.undoneAt ? `Undone: ${labelAction(item.action.action)}` : labelAction(item.action.action)}
                </span>
                <strong>{item.action.actorName || "Reviewer"}</strong>
                <time>{formatDateTime(item.action.createdAt)}</time>
                {!item.action.undoneAt ? (
                  <button className="quiet-button compact-button" type="button" onClick={() => { setCorrecting(item.action.actionId); setCorrection(["A", "B", "C", "NO_CLEAR", "KEPT_CURRENT", "RETEST_LATER"].includes(item.action.action) ? item.action.action : "A"); }}>
                    <Pencil size={14} /> Correct
                  </button>
                ) : <small>Undone by {item.action.undoneBy || "reviewer"}</small>}
                {item.studioUrl ? (
                  <a className="secondary-button compact-button" href={item.studioUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} /> Open Studio
                  </a>
                ) : null}
              </div>
              {correcting === item.action.actionId ? (
                <div className="history-correction">
                  <strong>Record the corrected outcome</strong>
                  <select value={correction} onChange={(event) => setCorrection(event.target.value)}>
                    <option value="A">Selected A</option><option value="B">Selected B</option><option value="C">Selected C</option>
                    <option value="NO_CLEAR">Not enough views / No clear</option><option value="KEPT_CURRENT">Kept current</option><option value="RETEST_LATER">Retest later</option>
                  </select>
                  <button className="primary-button compact-button" type="button" onClick={() => saveCorrection(item)} disabled={saving}>{saving ? "Saving..." : "Save correction"}</button>
                  <button className="icon-button" type="button" onClick={() => setCorrecting("")} title="Cancel correction"><X size={16} /></button>
                </div>
              ) : null}
            </article>
          ))}
          {loading ? <div className="empty-state">Loading completed actions...</div> : null}
          {!loading && !filtered.length ? (
            <div className="empty-state">
              <Users size={22} />
              <strong>No actions match these filters</strong>
              <span>{items.length ? "Adjust the filters above." : "Completed decisions will appear here for the whole team."}</span>
            </div>
          ) : null}
        </section>
      </main>
    </AppShell>
  );
}

function labelAction(action) {
  if (["A", "B", "C"].includes(action)) return `Selected ${action}`;
  if (action === "NO_CLEAR") return "Not enough views / No clear winner";
  return String(action || "Done").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function actionTone(action) {
  if (action === "A") return "option-a";
  if (action === "B") return "option-b";
  if (action === "C") return "option-c";
  if (action === "NO_CLEAR") return "no-clear";
  return "neutral";
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
