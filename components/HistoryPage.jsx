"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

export default function HistoryPage({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  return (
    <AppShell session={session} active="history">
      <main className="workspace">
        <section className="hero-row">
          <div>
            <p className="eyebrow">Shared team state</p>
            <h2>Completed test actions</h2>
            <p className="muted">Search by video, channel, video ID, action, or reviewer.</p>
          </div>
        </section>
        <label className="search-box history-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search history"
          />
        </label>
        {error ? <div className="error-banner">{error}</div> : null}
        <section className="history-list">
          {items.map((item) => (
            <article className="history-item" key={`${item.action.actionId}-${item.testRunId}`}>
              <div>
                <span className="type-pill">{item.testType}</span>
                <h3>{item.videoTitle || item.currentYoutubeTitle || item.videoId}</h3>
                <p className="muted">
                  {item.channel} | {item.effectiveFinishDate || "No finish date"}
                </p>
              </div>
              <div className="history-action">
                <strong>{labelAction(item.action.action)}</strong>
                <span>{item.action.actorName}</span>
                <span>{formatDateTime(item.action.createdAt)}</span>
                {item.studioUrl ? <a href={item.studioUrl} target="_blank" rel="noreferrer">Open Studio</a> : null}
              </div>
            </article>
          ))}
          {loading ? <div className="empty-state">Loading completed actions...</div> : null}
          {!loading && !items.length ? (
            <div className="empty-state">{search ? "No completed actions match this search." : "No completed actions yet."}</div>
          ) : null}
        </section>
      </main>
    </AppShell>
  );
}

function labelAction(action) {
  if (["A", "B", "C"].includes(action)) return `Done ${action}`;
  return String(action || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
