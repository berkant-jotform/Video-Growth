"use client";

import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import AppShell from "@/components/AppShell.jsx";

export default function UploadsPage({ session }) {
  const [file, setFile] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const response = await fetch("/api/uploads/thumbnail-xlsx");
    const payload = await response.json();
    if (response.ok && payload.ok) setUploads(payload.uploads || []);
  }

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!file) {
      setError("Choose an XLSX snapshot.");
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    form.append("sourceKind", "thumbnail");
    const response = await fetch("/api/uploads/thumbnail-xlsx", {
      method: "POST",
      body: form
    });
    const payload = await response.json();
    setBusy(false);
    if (!response.ok || !payload.ok) {
      setError(payload.error || "Upload failed.");
      return;
    }
    setMessage(`Imported ${payload.importedCount} thumbnail previews.`);
    setFile(null);
    await load();
  }

  return (
    <AppShell session={session} active="uploads">
      <main className="workspace settings-grid">
        <section className="settings-panel">
          <p className="eyebrow">Thumbnail snapshots</p>
          <h2>Upload XLSX preview source</h2>
          <form className="form-stack" onSubmit={submit}>
            <label>
              Thumbnail workbook snapshot
              <input
                type="file"
                accept=".xlsx"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button" disabled={busy}>
              <Upload size={17} />
              {busy ? "Uploading" : "Upload Snapshot"}
            </button>
          </form>
        </section>

        <section className="settings-panel">
          <p className="eyebrow">Recent imports</p>
          <h2>Preview cache</h2>
          <div className="upload-list">
            {uploads.map((item) => (
              <div className="upload-row" key={item.uploadId}>
                <strong>{item.filename}</strong>
                <span>
                  {item.importedCount} previews | {formatDateTime(item.createdAt)}
                </span>
              </div>
            ))}
            {!uploads.length ? <p className="muted">No uploads yet.</p> : null}
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
