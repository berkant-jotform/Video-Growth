import { getAppConfig } from "@/lib/config.js";
import { canonicalChannelName } from "@/lib/channels.mjs";
import { parseWorkbookRecords } from "@/lib/domain.mjs";
import { downloadPublicSpreadsheetBuffer, readSpreadsheetValues } from "@/lib/sheets.js";
import { importThumbnailWorkbookBuffer } from "@/lib/uploads.js";
import { enrichWithYouTubeMetadata } from "@/lib/youtube.js";
import {
  completeScanRun,
  createScanRun,
  flagMissingCompletedRuns,
  loadThumbnailPreviewMap,
  previewKey,
  summarizeQueue,
  updateScanProgress,
  upsertScannedRuns,
  listQueue,
  cleanupInlineThumbnailData,
  recordAppliedChangeEvents
} from "@/lib/repository.js";

export async function runScan({ actorName = "system", channel = "all", testType = "all", refreshThumbnails = false } = {}) {
  const config = await getAppConfig();
  const scanId = await createScanRun({ actorName });
  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  const scannedKinds = [];
  const timings = {};
  const startedAt = Date.now();
  const filters = {
    channel: channel && channel !== "all" ? channel : "",
    testType: testType && testType !== "all" ? testType : ""
  };
  const partialScan = Boolean(filters.channel || filters.testType);
  const counts = {
    titleRows: 0,
    thumbnailRows: 0,
    totalRows: 0,
    filteredRows: 0,
    thumbnailPreviews: 0,
    enrichedRows: 0,
    appliedSignals: 0,
    timings
  };

  const progress = (stage, label, percent, detail = "") =>
    updateScanProgress({ scanId, stage, label, percent, detail, counts });
  const timed = async (key, fn) => {
    const stageStart = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] = Date.now() - stageStart;
      timings.total = Date.now() - startedAt;
    }
  };

  try {
    await progress(
      "starting",
      "Preparing scan",
      4,
        partialScan ? "Preparing filtered scan. Other channels will not be marked missing." : "Preparing full refresh."
    );
    await timed("prepare", () => cleanupInlineThumbnailData());
    for (const source of [
      { sourceKind: "title", spreadsheetId: config.titleSpreadsheetId },
      { sourceKind: "thumbnail", spreadsheetId: config.thumbnailSpreadsheetId }
    ]) {
      if (filters.testType && source.sourceKind !== filters.testType) continue;
      if (!source.spreadsheetId) continue;
      scannedKinds.push(source.sourceKind);
      await progress(
        "read_sheets",
        `Reading ${source.sourceKind} sheet`,
        source.sourceKind === "title" ? 12 : 24,
        `Fetching ${source.sourceKind} test rows from Google Sheets.`
      );
      const sheets = await timed(`read_${source.sourceKind}`, () =>
        readSpreadsheetValues({
          spreadsheetId: source.spreadsheetId,
          config
        })
      );
      const parsed = parseWorkbookRecords({
        spreadsheetId: source.spreadsheetId,
        sourceKind: source.sourceKind,
        sheets,
        today
      });
      const scoped = parsed.filter((record) => matchesScanFilters(record, filters));
      records.push(...scoped);
      if (source.sourceKind === "title") counts.titleRows = parsed.length;
      if (source.sourceKind === "thumbnail") counts.thumbnailRows = parsed.length;
      counts.totalRows = records.length;
      counts.filteredRows += Math.max(0, parsed.length - scoped.length);
    }

    if (refreshThumbnails && config.thumbnailSpreadsheetId && config.blobReadWriteToken && (!filters.testType || filters.testType === "thumbnail")) {
      try {
        await progress(
          "thumbnail_previews",
          "Updating thumbnail previews",
          38,
          "Exporting the thumbnail sheet and extracting preview images."
        );
        const buffer = await timed("thumbnail_export", () =>
          downloadPublicSpreadsheetBuffer({
            spreadsheetId: config.thumbnailSpreadsheetId
          })
        );
        const imported = await timed("thumbnail_import", () =>
          importThumbnailWorkbookBuffer({
            buffer,
            filename: "online-thumbnail-sheet.xlsx",
            sourceKind: "thumbnail",
            blobToken: config.blobReadWriteToken,
            uploadId: `scan-${scanId}`,
            saveUploadRecord: false
          })
        );
        counts.thumbnailPreviews = imported.importedCount;
        if (imported.importedCount > 0) {
          warnings.push(`Updated ${imported.importedCount} thumbnail previews from the online sheet.`);
        }
      } catch (error) {
        warnings.push(`Thumbnail previews skipped: ${error.message}`);
      }
    } else if (refreshThumbnails && config.thumbnailSpreadsheetId && !config.blobReadWriteToken) {
      warnings.push("Embedded thumbnail previews skipped. Configure Vercel Blob to store sheet images.");
    }

    await progress(
      "thumbnail_previews",
      "Mapping thumbnail previews",
      48,
      "Matching stored preview images to thumbnail A/B/C rows."
    );
    const previewMap = await timed("thumbnail_map", () => loadThumbnailPreviewMap());
    for (const record of records) {
      if (record.testType !== "thumbnail") continue;
      for (const option of ["A", "B", "C"]) {
        const url = previewMap.get(
          previewKey(record.sourceKind, record.sheetName, record.rowNumber, option)
        );
        if (url) record.thumbnailPreviews[option] = url;
      }
    }

    await progress(
      "youtube_metadata",
      "Checking current YouTube metadata",
      62,
      `Fetching current titles, thumbnails, and channel data for ${records.length} rows.`
    );
    const enriched = await timed("youtube_metadata", () => enrichWithYouTubeMetadata(records, config));
    counts.enrichedRows = enriched.records.length;
    warnings.push(...enriched.warnings);
    await progress(
      "save_runs",
      "Saving scan results",
      78,
      "Updating the shared queue cache without writing to Google Sheets."
    );
    await timed("save_runs", () => upsertScannedRuns({ records: enriched.records, scanId }));
    await progress(
      "finish_signals",
      "Checking finish signals",
      88,
      "Comparing metadata and connector events against active tests."
    );
    const appliedEvents = await timed("finish_signals", () => recordAppliedChangeEvents(enriched.records));
    counts.appliedSignals = appliedEvents.length;
    if (appliedEvents.length) {
      warnings.push(`Observed ${appliedEvents.length} possible applied B/C metadata changes.`);
    }
    await progress(
      "finish_signals",
      "Finalizing queue",
      94,
      "Marking missing rows, refreshing counts, and preparing the dashboard."
    );
    if (!partialScan) {
      await timed("flag_missing", () => flagMissingCompletedRuns({ scanId, sourceKinds: scannedKinds }));
    }
    const queue = await timed("refresh_queue", () => listQueue());
    const summary = summarizeQueue(queue);
    await completeScanRun({ scanId, status: "ok", summary, warnings });
    return { ok: true, scanId, summary, warnings, scanned: records.length, timings, partialScan };
  } catch (error) {
    await completeScanRun({
      scanId,
      status: "failed",
      summary: { error: error.message },
      warnings
    });
    throw error;
  }
}

function matchesScanFilters(record, filters) {
  if (filters.testType && record.testType !== filters.testType) return false;
  if (filters.channel) {
    const candidates = [record.channel, record.sheetName, record.youtubeChannelTitle]
      .map(normalizeText)
      .filter(Boolean);
    if (!candidates.includes(normalizeText(filters.channel))) return false;
  }
  return true;
}

function normalizeText(value) {
  return String(canonicalChannelName(value) || value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
