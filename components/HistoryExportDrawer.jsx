"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  Info,
  RefreshCw,
  ShieldAlert,
  X
} from "lucide-react";

const ROW_OPTIONS = [
  {
    value: "all_completed",
    title: "All completed tests",
    description: "Every finished test or test with a reviewer decision."
  },
  {
    value: "current_view",
    title: "Tests with reviewer actions only",
    description: "A narrow operational subset, not the complete test history."
  },
  {
    value: "everything",
    title: "Everything",
    description: "Finished, watching, unknown, and app-managed tests."
  }
];

const CONTENT_OPTIONS = [
  {
    value: "workbook",
    title: "Analysis workbook",
    description: "Seven clean Excel and Google Sheets-ready tabs.",
    icon: FileSpreadsheet
  },
  {
    value: "workbook_audit",
    title: "Workbook + audit package",
    description: "Adds raw source links, signals, scans, IDs, and checksums.",
    icon: Archive
  }
];

export default function HistoryExportDrawer({
  actorName,
  inheritedFilters,
  recent,
  onClose,
  onRecentChange,
  onRerunFilters,
  onChangeScope,
  onWidenScope
}) {
  const [rows, setRows] = useState("all_completed");
  const [contents, setContents] = useState("workbook");
  const [includeReviewerNotes, setIncludeReviewerNotes] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const previewSequence = useRef(0);

  const request = useMemo(
    () => ({
      rows,
      contents,
      includeReviewerNotes,
      filters: inheritedFilters
    }),
    [rows, contents, includeReviewerNotes, inheritedFilters]
  );
  const rowOptions = useMemo(
    () => rowOptionsForPreview(preview),
    [preview]
  );

  useEffect(() => {
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError("");
      try {
        const response = await fetch("/api/history/export/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Could not preview this export.");
        }
        if (sequence === previewSequence.current) setPreview(payload.preview);
      } catch (error) {
        if (error.name !== "AbortError" && sequence === previewSequence.current) {
          setPreview(null);
          setPreviewError(error.message || "Could not preview this export.");
        }
      } finally {
        if (sequence === previewSequence.current) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  async function generate() {
    setGenerating(true);
    setDownloadError("");
    setDownloadNotice("");
    setGenerationStep("Preparing the selected logical tests");
    const stageTimer = setTimeout(
      () => setGenerationStep("Building the verified workbook"),
      900
    );
    try {
      const response = await fetch("/api/history/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Could not create the export.");
      }
      setGenerationStep("Starting the download");
      const blob = await response.blob();
      const fileName =
        parseDownloadName(response.headers.get("Content-Disposition")) ||
        "YT_AB_Tests.xlsx";
      downloadBlob(blob, fileName);
      setDownloadNotice(response.headers.get("X-Export-Storage-Warning") || "");
      await refreshRecent();
      setGenerationStep("Downloaded");
    } catch (error) {
      setDownloadError(error.message || "Could not create the export.");
      setGenerationStep("");
    } finally {
      clearTimeout(stageTimer);
      setGenerating(false);
    }
  }

  async function refreshRecent() {
    try {
      const response = await fetch("/api/history/export/status", {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok) onRecentChange(payload.recent || []);
    } catch {
      // The download succeeded; recent-export refresh is secondary.
    }
  }

  async function downloadRecent(item) {
    if (!item.downloadAvailable) return;
    setDownloadError("");
    try {
      const response = await fetch(`/api/history/export/${item.exportId}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Stored export is unavailable.");
      }
      downloadBlob(await response.blob(), item.fileName);
    } catch (error) {
      setDownloadError(error.message || "Stored export is unavailable.");
    }
  }

  function rerun(item) {
    const next = item.request || {};
    onRerunFilters(next.filters || {});
    setRows(next.rows || "all_completed");
    setContents(next.contents || "workbook");
    setIncludeReviewerNotes(Boolean(next.includeReviewerNotes));
  }

  const disabled = previewLoading || preview?.blocking || !preview?.logicalTests || generating;
  function widenScope() {
    setRows((current) => current === "current_view" ? "all_completed" : current);
    onWidenScope?.();
  }

  return (
    <div className="history-export-layer" role="presentation">
      <button
        className="history-export-backdrop"
        type="button"
        aria-label="Close export drawer"
        onClick={onClose}
      />
      <aside className="history-export-drawer" role="dialog" aria-modal="true" aria-labelledby="history-export-title">
        <header className="history-export-header">
          <div>
            <p className="eyebrow">History export</p>
            <h2 id="history-export-title">Export tests</h2>
            <p>Analysis-ready data with explicit evidence, quality, and denominators.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close export">
            <X size={18} />
          </button>
        </header>

        <div className="history-export-scroll">
          <section className="export-preview-panel" aria-live="polite">
            <div className="export-section-heading">
              <div>
                <span>Live preview</span>
                <strong>
                  {previewLoading
                    ? "Calculating scope"
                    : scopeCountLabel(
                      preview?.logicalTests,
                      preview?.fullPopulation?.logicalTests,
                      "logical tests"
                    )}
                </strong>
              </div>
              {!previewLoading && preview ? (
                <em>
                  {scopeCountLabel(
                    preview.sourceRecords,
                    preview.fullPopulation?.sourceRecords,
                    "source records"
                  )}
                </em>
              ) : null}
            </div>
            {previewLoading ? <PreviewSkeleton /> : null}
            {previewError ? (
              <div className="export-inline-error">
                <AlertCircle size={17} />
                <span>{previewError}</span>
              </div>
            ) : null}
            {!previewLoading && preview ? <PreviewMetrics preview={preview} /> : null}
          </section>

          {!previewLoading && preview?.warnings?.length ? (
            <section className="export-warning-list" aria-label="Export warnings">
              {preview.warnings.map((warning, index) => (
                <ExportWarning
                  key={`${warning.level}-${warning.message}-${index}`}
                  warning={warning}
                  onChangeScope={onChangeScope}
                  onWidenScope={widenScope}
                />
              ))}
            </section>
          ) : null}

          <section className="export-control-section">
            <div className="export-section-heading">
              <div>
                <span>Inherited filters</span>
                <strong>History filters only</strong>
              </div>
            </div>
            <div className="export-filter-chips">
              {filterChips(inheritedFilters).map((chip) => (
                <span key={chip}>{chip}</span>
              ))}
            </div>
            <details className="export-override-help">
              <summary>Override filters</summary>
              <p>The channel, outcome, type, and search filters are inherited. The Rows choice below controls the population independently.</p>
              <button className="secondary-button compact-button" type="button" onClick={onChangeScope}>
                Change History filters
              </button>
            </details>
          </section>

          <section className="export-control-section">
            <div className="export-section-heading">
              <div>
                <span>Rows</span>
                <strong>Choose the population</strong>
              </div>
            </div>
            <div className="export-choice-grid rows">
              {rowOptions.map((option) => (
                <ChoiceCard
                  key={option.value}
                  option={option}
                  selected={rows === option.value}
                  onSelect={() => setRows(option.value)}
                  name="history-export-rows"
                />
              ))}
            </div>
          </section>

          <section className="export-control-section">
            <div className="export-section-heading">
              <div>
                <span>Contents</span>
                <strong>Choose the file package</strong>
              </div>
            </div>
            <div className="export-choice-grid">
              {CONTENT_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.value}
                  option={option}
                  selected={contents === option.value}
                  onSelect={() => setContents(option.value)}
                  name="history-export-contents"
                />
              ))}
            </div>
            <label className="export-notes-toggle">
              <input
                type="checkbox"
                checked={includeReviewerNotes}
                onChange={(event) => setIncludeReviewerNotes(event.target.checked)}
              />
              <span>
                <strong>Include reviewer notes</strong>
                <em>Off by default. Reviewer names and actions are always included.</em>
              </span>
            </label>
          </section>

          <section className="recent-export-section">
            <div className="export-section-heading">
              <div>
                <span>Recent exports</span>
                <strong>Last five team files</strong>
              </div>
            </div>
            {recent.length ? (
              <div className="recent-export-list">
                {recent.slice(0, 5).map((item) => (
                  <article key={item.exportId}>
                    <div>
                      <strong>{item.fileName}</strong>
                      <span>
                        {item.actorName} · {formatDateTime(item.createdAt)} · {item.counts?.logicalTests || 0} tests · schema {item.schemaVersion}
                      </span>
                      <em>{describeRecentFilters(item.request?.filters)}</em>
                    </div>
                    <div>
                      <button
                        className="icon-button"
                        type="button"
                        title={item.downloadAvailable ? "Download again" : "File was not stored"}
                        disabled={!item.downloadAvailable}
                        onClick={() => downloadRecent(item)}
                      >
                        <Download size={16} />
                      </button>
                      <button className="quiet-button compact-button" type="button" onClick={() => rerun(item)}>
                        <RefreshCw size={14} />
                        Re-run
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="export-empty-recent">
                <History size={18} />
                <span>Generated exports will appear here.</span>
              </div>
            )}
          </section>
        </div>

        <footer className="history-export-footer">
          <div>
            <strong>{generationStep || `${actorName} will be recorded as creator`}</strong>
            <span>{contents === "workbook_audit" ? "Downloads a ZIP with workbook and audit records." : "Downloads an Excel workbook."}</span>
            {downloadError ? <em>{downloadError}</em> : null}
            {downloadNotice ? <span className="export-storage-notice">{downloadNotice}</span> : null}
          </div>
          <button className="primary-button" type="button" disabled={disabled} onClick={generate}>
            {generating ? <RefreshCw className="spin" size={17} /> : <Download size={17} />}
            {generating ? "Creating export" : preview?.blocking ? "Resolve warning first" : "Download export"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function PreviewMetrics({ preview }) {
  const fullTests = preview.fullPopulation?.logicalTests || 0;
  const fullShares = preview.fullPopulation?.sharesPresent || 0;
  const testRate = formatPercent(preview.scopeCoverage?.logicalTests);
  const shareRate = formatPercent(preview.scopeCoverage?.sharesPresent);
  return (
    <>
      <div className="export-preview-metrics">
        <div>
          <span>Tests</span>
          <strong>{formatCount(preview.logicalTests)} <b>of {formatCount(fullTests)}</b></strong>
          <em>{testRate} of the full logical-test population</em>
        </div>
        <div><span>Variants</span><strong>{preview.variants}</strong><em>A/B/C evidence rows</em></div>
        <div className="coverage">
          <span>Shares present</span>
          <strong>{formatCount(preview.sharesPresent)} <b>of {formatCount(fullShares)}</b></strong>
          <em>{shareRate} of all share-bearing tests</em>
        </div>
        <div><span>Actions</span><strong>{preview.actions}</strong><em>review decisions</em></div>
        <div><span>Signals</span><strong>{preview.signals}</strong><em>finish evidence</em></div>
        <div><span>Date span</span><strong>{formatSpan(preview.dateSpan)}</strong><em>available evidence</em></div>
      </div>
      <div className="export-denominator-summary">
        <span>
          <strong>{preview.coveragePopulation?.strictEligibleN ?? 0}</strong>
          terminal-evidence tests
        </span>
        <span>
          <strong>{preview.coveragePopulation?.widerEligibleN ?? 0}</strong>
          wider coverage denominator
        </span>
        <span>
          <strong>{preview.overThreeWeeksCount ?? 0}</strong>
          starts 21+ days old without finish evidence
        </span>
      </div>
      <details className="export-coverage-details">
        <summary>Missing coverage by channel and period</summary>
        <div>
          <CoverageList title="Channels" rows={preview.missingCoverageByChannel} />
          <CoverageList title="Start period" rows={preview.missingCoverageByPeriod} />
        </div>
      </details>
    </>
  );
}

function PreviewSkeleton() {
  return (
    <div className="export-preview-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index}><i /><b /></span>
      ))}
    </div>
  );
}

function CoverageList({ title, rows = [] }) {
  return (
    <div>
      <strong>{title}</strong>
      {(rows || []).slice(0, 6).map((row) => (
        <span key={`${title}-${row.dimension}`}>
          {row.dimension}
          <em>{row.strictSharesN}/{row.eligibleN} strict shares</em>
        </span>
      ))}
      {!rows.length ? <span>No eligible rows</span> : null}
    </div>
  );
}

function ExportWarning({ warning, onChangeScope, onWidenScope }) {
  const Icon =
    warning.level === "blocking"
      ? ShieldAlert
      : warning.level === "degrading"
        ? AlertCircle
        : Info;
  const actionLabel = {
    refresh_sources: "Refresh sources",
    review_conflicts: "Review conflicts",
    change_scope: "Change scope",
    widen_scope: "Widen scope"
  }[warning.action] || "Review";
  const href =
    warning.action === "refresh_sources"
      ? "/#scan-health"
      : warning.action === "review_conflicts"
        ? "/review"
        : "";
  const action = warning.action === "widen_scope" ? onWidenScope : onChangeScope;
  return (
    <div className={`export-warning ${warning.level}`}>
      <Icon size={17} />
      <span>{warning.message}</span>
      {warning.action === "none" ? null : href ? (
        <a className="quiet-button compact-button" href={href}>{actionLabel}</a>
      ) : (
        <button className="quiet-button compact-button" type="button" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function rowOptionsForPreview(preview) {
  const full = preview?.fullPopulation?.logicalTests;
  const actionOnly = preview?.rowScopes?.current_view?.logicalTests;
  return ROW_OPTIONS.map((option) => {
    if (option.value !== "current_view" || !Number.isFinite(full) || !Number.isFinite(actionOnly)) {
      return option;
    }
    return {
      ...option,
      title: `Tests with reviewer actions only (${formatCount(actionOnly)} of ${formatCount(full)})`
    };
  });
}

function scopeCountLabel(value, full, unit) {
  if (!Number.isFinite(full)) return `${formatCount(value)} ${unit}`;
  return `${formatCount(value)} of ${formatCount(full)} ${unit}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "No denominator";
}

function ChoiceCard({ option, selected, onSelect, name }) {
  const Icon = option.icon || CheckCircle2;
  return (
    <label className={`export-choice ${selected ? "selected" : ""}`}>
      <input
        type="radio"
        name={name}
        value={option.value}
        checked={selected}
        onChange={onSelect}
      />
      <Icon size={18} />
      <span>
        <strong>{option.title}</strong>
        <em>{option.description}</em>
      </span>
    </label>
  );
}

function filterChips(filters) {
  const chips = [];
  if (filters.channel && filters.channel !== "all") chips.push(`Channel: ${filters.channel}`);
  if (filters.testType && filters.testType !== "all") chips.push(`Type: ${titleCase(filters.testType)}`);
  if (filters.action && filters.action !== "all") chips.push(`Outcome: ${titleCase(filters.action)}`);
  if (filters.search) chips.push(`Search: ${filters.search}`);
  return chips.length ? chips : ["All channels", "All test types", "All outcomes"];
}

function describeRecentFilters(filters = {}) {
  return filterChips(filters).join(" · ");
}

function parseDownloadName(header) {
  const match = String(header || "").match(/filename="([^"]+)"/i);
  return match?.[1] || "";
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function formatSpan(span) {
  if (!span?.start && !span?.end) return "No dates";
  if (span.start === span.end) return span.start;
  return `${span.start || "Unknown"} – ${span.end || "Unknown"}`;
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
