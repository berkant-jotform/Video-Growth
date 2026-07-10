"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Image as ImageIcon, ListChecks, RotateCcw, Type } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";
import { buildReviewQueue } from "@/lib/review-session.mjs";

const OUTCOMES = [
  ["A", "A"],
  ["B", "B"],
  ["C", "C"],
  ["NO_CLEAR", "Not enough views / No clear"],
  ["KEPT_CURRENT", "Kept current"],
  ["RETEST_LATER", "Retest later"]
];

export default function ReviewSessionPage({ session }) {
  const [runs, setRuns] = useState([]);
  const [channel, setChannel] = useState("all");
  const [testType, setTestType] = useState("all");
  const [skipped, setSkipped] = useState([]);
  const [handled, setHandled] = useState(0);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/queue", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load review queue.");
      setRuns(payload.runs || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load review queue.");
    } finally {
      setLoading(false);
    }
  }

  const channels = useMemo(
    () => Array.from(new Set(runs.filter((run) => ["confirmed_finished", "action_conflict"].includes(run.queueStatus)).map((run) => run.channel).filter(Boolean))).sort(),
    [runs]
  );
  const queue = useMemo(
    () => buildReviewQueue(runs, { channel, testType, skippedIds: skipped }),
    [runs, channel, testType, skipped]
  );
  const safeIndex = queue.length ? Math.min(index, queue.length - 1) : 0;
  const run = queue[safeIndex] || null;

  useEffect(() => {
    if (index >= queue.length) setIndex(Math.max(0, queue.length - 1));
  }, [queue.length, index]);

  async function complete(action) {
    if (!run) return;
    setSaving(action);
    setError("");
    try {
      const response = await fetch("/api/actions/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testRunId: run.testRunId, action, retestConfirmed: true })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save outcome.");
      setRuns((current) => current.filter((item) => item.testRunId !== run.testRunId));
      setHandled((value) => value + 1);
    } catch (saveError) {
      setError(saveError.message || "Could not save outcome.");
    } finally {
      setSaving("");
    }
  }

  function skipCurrent() {
    if (!run) return;
    setSkipped((current) => [...current, run.testRunId]);
  }

  function resetSession() {
    setSkipped([]);
    setHandled(0);
    setIndex(0);
    load();
  }

  return (
    <AppShell session={session} active="review">
      <main className="workspace review-workspace">
        <section className="page-intro review-intro">
          <div>
            <p className="eyebrow">Focused workflow</p>
            <h2>Review session</h2>
            <p className="muted">Handle confirmed finishes one at a time without Watching, Missing Data, or setup noise.</p>
          </div>
          <div className="review-session-stats">
            <span><strong>{queue.length}</strong> remaining</span>
            <span><strong>{handled}</strong> handled now</span>
            <button className="icon-button" type="button" title="Restart session" onClick={resetSession}><RotateCcw size={17} /></button>
          </div>
        </section>

        <section className="review-toolbar">
          <label><span>Channel</span><select value={channel} onChange={(event) => { setChannel(event.target.value); setIndex(0); }}><option value="all">All channels</option>{channels.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
          <div className="segmented" role="group" aria-label="Test type">
            {[["all", "All"], ["title", "Title"], ["thumbnail", "Thumbnail"]].map(([value, label]) => <button type="button" className={testType === value ? "active" : ""} key={value} onClick={() => { setTestType(value); setIndex(0); }}>{label}</button>)}
          </div>
          {run ? <span className="review-position">{safeIndex + 1} of {queue.length}</span> : null}
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <div className="empty-state">Loading confirmed tests...</div> : null}
        {!loading && !run ? (
          <section className="review-complete-state">
            <CheckCircle2 size={34} />
            <h2>Review queue complete</h2>
            <p>{skipped.length ? `${skipped.length} skipped item${skipped.length === 1 ? " is" : "s are"} hidden for this session.` : "No confirmed tests remain in this scope."}</p>
            {skipped.length ? <button className="secondary-button" type="button" onClick={() => setSkipped([])}>Show skipped items</button> : <a className="secondary-button" href="/">Return to Detector</a>}
          </section>
        ) : null}

        {run ? (
          <article className={`review-card ${run.testType}-test`}>
            <header className="review-card-header">
              <div className="review-channel">
                {run.youtubeChannelThumbnailUrl ? <img src={run.youtubeChannelThumbnailUrl} alt="" /> : <span>{channelInitials(run.channel)}</span>}
                <div><strong>{run.channel || "Unknown channel"}</strong><em>{run.sourceKind === "app_registry" ? "App managed" : "Sheet connected"}</em></div>
              </div>
              <div className="review-card-badges">
                <span className={`type-pill ${run.testType}-type`}>{run.testType === "thumbnail" ? <ImageIcon size={14} /> : <Type size={14} />}{titleCase(run.testType)} test</span>
                <span className="result-pill success">{outcomeLabel(run)}</span>
              </div>
            </header>

            <div className="review-card-body">
              <div className="review-primary">
                {run.currentYoutubeThumbnailUrl ? <img className="review-current-thumbnail" src={run.currentYoutubeThumbnailUrl} alt="Current YouTube thumbnail" /> : null}
                <p className="eyebrow">Video</p>
                <h2>{run.videoTitle || run.currentYoutubeTitle || run.videoId}</h2>
                <p className="review-signal-reason">{run.sourceKind === "app_registry" ? "Confirmed by Studio and tracked independently by the app." : run.finishEventSource?.includes("studio") ? "Confirmed by a real Studio finish signal." : "Finished according to the configured sheet."}</p>
                <a className="studio-button review-studio-button" href={run.studioUrl || "#"} target="_blank" rel="noreferrer"><ExternalLink size={18} />Open Studio</a>
              </div>
              <ReviewOptions run={run} />
            </div>

            <footer className="review-actions">
              <div className="review-outcomes">
                {OUTCOMES.filter(([value]) => value !== "C" || run.options?.C || run.testType === "thumbnail" && run.thumbnailPreviews?.C).map(([value, label]) => (
                  <button type="button" className={`review-outcome outcome-${value.toLowerCase()}`} key={value} disabled={Boolean(saving)} onClick={() => complete(value)}>{saving === value ? "Saving..." : label}</button>
                ))}
              </div>
              <div className="review-navigation">
                <button className="icon-button" type="button" disabled={safeIndex === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))} title="Previous"><ChevronLeft size={18} /></button>
                <button className="quiet-button" type="button" onClick={skipCurrent}>Skip for now</button>
                <button className="icon-button" type="button" disabled={safeIndex >= queue.length - 1} onClick={() => setIndex((value) => Math.min(queue.length - 1, value + 1))} title="Next"><ChevronRight size={18} /></button>
              </div>
            </footer>
          </article>
        ) : null}
      </main>
    </AppShell>
  );
}

function ReviewOptions({ run }) {
  const options = ["A", "B", "C"].filter((key) => run.options?.[key] || run.thumbnailPreviews?.[key]);
  if (!options.length) return <aside className="review-options empty"><ListChecks size={24} /><strong>No A/B options stored</strong><span>Use Studio to inspect the outcome, then record your decision below.</span></aside>;
  return (
    <aside className="review-options">
      <p className="eyebrow">Test options</p>
      {options.map((key) => (
        <div className={`review-option option-${key.toLowerCase()}`} key={key}>
          <span>{key}</span>
          {run.thumbnailPreviews?.[key] ? <img src={run.thumbnailPreviews[key]} alt={`Thumbnail ${key}`} /> : <strong>{run.options?.[key]}</strong>}
          {run.watchTimeShare?.[key] !== null && run.watchTimeShare?.[key] !== undefined ? <em>{run.watchTimeShare[key]}%</em> : null}
        </div>
      ))}
    </aside>
  );
}

function outcomeLabel(run) {
  if (run.detectedOutcome === "no_clear" || run.finishEventOutcome === "no_clear") return "No clear winner";
  if (run.suggestedWinner && /^[ABC]$/.test(run.suggestedWinner)) return `Suggested ${run.suggestedWinner}`;
  return run.queueStatus === "action_conflict" ? "Action conflict" : "Confirmed finished";
}

function channelInitials(value) {
  return String(value || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
