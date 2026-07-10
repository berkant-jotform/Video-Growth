"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Image, Upload } from "lucide-react";
import { upload as uploadToBlob } from "@vercel/blob/client";
import AppShell from "@/components/AppShell.jsx";

export default function UploadsPage({ session }) {
  const [file, setFile] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inputKey, setInputKey] = useState(0);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const response = await fetch("/api/uploads/thumbnail-xlsx");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load imports.");
      setUploads(payload.uploads || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load imports.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!file) {
      setError("Choose an XLSX snapshot.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Choose an .xlsx workbook snapshot.");
      return;
    }
    if (file.size > 220 * 1024 * 1024) {
      setError("This workbook is larger than 220 MB. Export only the active thumbnail tabs and try again.");
      return;
    }
    setBusy(true);
    setPhase("Uploading workbook");
    setProgress(0);
    try {
      const pathname = `thumbnail-workbooks/${Date.now()}-${safeFilename(file.name)}`;
      const stored = await uploadToBlob(pathname, file, {
        access: "private",
        handleUploadUrl: "/api/uploads/thumbnail-xlsx/token",
        multipart: true,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        onUploadProgress: ({ percentage }) => setProgress(Math.max(0, Math.min(100, Math.round(percentage))))
      });
      setPhase("Extracting thumbnail previews");
      setProgress(100);
      const response = await fetch("/api/uploads/thumbnail-xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: stored.url, filename: file.name, sourceKind: "thumbnail" })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Upload failed.");
      setMessage(`Imported ${payload.importedCount} thumbnail previews.`);
      setFile(null);
      setInputKey((value) => value + 1);
      await load();
    } catch (uploadError) {
      setError(uploadError.message || "Upload failed.");
    } finally {
      setBusy(false);
      setPhase("");
      setProgress(0);
    }
  }

  return (
    <AppShell session={session} active="uploads">
      <main className="workspace uploads-workspace">
        <section className="page-intro uploads-intro">
          <div>
            <p className="eyebrow">Thumbnail maintenance</p>
            <h2>Refresh card previews</h2>
            <p className="muted">Normal scans do not need an upload. Use a snapshot only when A/B/C images are missing or outdated.</p>
          </div>
          <div className="upload-safety-note">
            <CheckCircle2 size={18} />
            <span><strong>Read-only import</strong>Nothing is written to YouTube or Google Sheets.</span>
          </div>
        </section>

        <section className="upload-layout">
          <form className="settings-panel upload-panel" onSubmit={submit}>
            <div className="panel-heading-row">
              <span className="panel-icon"><Image size={20} /></span>
              <div>
                <p className="eyebrow">New snapshot</p>
                <h2>Import embedded thumbnails</h2>
              </div>
            </div>
            <p className="muted">Export a smaller XLSX containing the active thumbnail-test tabs. Maximum size: 220 MB.</p>
            <label className={`upload-dropzone ${file ? "has-file" : ""}`}>
              <input
                key={inputKey}
                type="file"
                accept=".xlsx"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
                disabled={busy}
              />
              <FileSpreadsheet size={28} />
              <strong>{file ? file.name : "Choose an XLSX snapshot"}</strong>
              <span>{file ? formatBytes(file.size) : "Click to browse your computer"}</span>
            </label>
            {busy ? (
              <div className="upload-progress" role="status" aria-live="polite">
                <div className="upload-progress-copy">
                  <strong>{phase}</strong>
                  <span>{phase === "Uploading workbook" ? `${progress}%` : "Processing"}</span>
                </div>
                <div className="upload-progress-track" aria-hidden="true">
                  <span style={{ width: phase === "Uploading workbook" ? `${progress}%` : "100%" }} />
                </div>
                <p>Keep this page open. You can continue using the detector after the import finishes.</p>
              </div>
            ) : null}
            {error ? <p className="form-error">{error}</p> : null}
            {message ? <p className="form-success">{message}</p> : null}
            <button className="primary-button" disabled={busy || !file}>
              <Upload size={17} />
              {busy ? phase : "Import Previews"}
            </button>
          </form>

          <section className="settings-panel upload-history-panel">
            <div className="panel-heading-row">
              <span className="panel-icon"><FileSpreadsheet size={20} /></span>
              <div>
                <p className="eyebrow">Preview cache</p>
                <h2>Recent imports</h2>
              </div>
            </div>
            <p className="muted">The newest imported image for each sheet row and option is used on detector cards.</p>
          <div className="upload-list">
            {uploads.map((item) => (
              <div className="upload-row" key={item.uploadId}>
                <span className="upload-row-icon"><FileSpreadsheet size={17} /></span>
                <div><strong>{item.filename}</strong><span>{formatDateTime(item.createdAt)}</span></div>
                <em>{item.importedCount} previews</em>
              </div>
            ))}
            {loading ? <p className="muted">Loading imports...</p> : null}
            {!loading && !uploads.length ? <div className="empty-state"><strong>No snapshots imported</strong><span>Cards can still use the current YouTube thumbnail.</span></div> : null}
          </div>
          </section>
        </section>
      </main>
    </AppShell>
  );
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function safeFilename(value) {
  return String(value || "thumbnail-snapshot.xlsx")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-120) || "thumbnail-snapshot.xlsx";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
