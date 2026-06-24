"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

export default function HistoryPage({ session }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => load(), 200);
    return () => clearTimeout(timer);
  }, [search]);

  async function load() {
    setError("");
    const response = await fetch(`/api/history?q=${encodeURIComponent(search)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setError(payload.error || "History failed.");
      return;
    }
    setItems(payload.items || []);
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
              </div>
            </article>
          ))}
          {!items.length ? <div className="empty-state">No completed actions yet.</div> : null}
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
