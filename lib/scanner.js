import { getAppConfig } from "@/lib/config.js";
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

export async function runScan({ actorName = "system" } = {}) {
  const config = await getAppConfig();
  const scanId = await createScanRun({ actorName });
  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  const scannedKinds = [];
  const counts = {
    titleRows: 0,
    thumbnailRows: 0,
    totalRows: 0,
    thumbnailPreviews: 0,
    enrichedRows: 0,
    appliedSignals: 0
  };

  const progress = (stage, label, percent, detail = "") =>
    updateScanProgress({ scanId, stage, label, percent, detail, counts });

  try {
    await progress("starting", "Preparing scan", 4, "Cleaning old inline thumbnail data.");
    await cleanupInlineThumbnailData();
    for (const source of [
      { sourceKind: "title", spreadsheetId: config.titleSpreadsheetId },
      { sourceKind: "thumbnail", spreadsheetId: config.thumbnailSpreadsheetId }
    ]) {
      if (!source.spreadsheetId) continue;
      scannedKinds.push(source.sourceKind);
      await progress(
        "read_sheets",
        `Reading ${source.sourceKind} sheet`,
        source.sourceKind === "title" ? 12 : 24,
        `Fetching ${source.sourceKind} test rows from Google Sheets.`
      );
      const sheets = await readSpreadsheetValues({
        spreadsheetId: source.spreadsheetId,
        config
      });
      const parsed = parseWorkbookRecords({
        spreadsheetId: source.spreadsheetId,
        sourceKind: source.sourceKind,
        sheets,
        today
      });
      records.push(...parsed);
      if (source.sourceKind === "title") counts.titleRows = parsed.length;
      if (source.sourceKind === "thumbnail") counts.thumbnailRows = parsed.length;
      counts.totalRows = records.length;
    }

    if (config.thumbnailSpreadsheetId && config.blobReadWriteToken) {
      try {
        await progress(
          "thumbnail_previews",
          "Updating thumbnail previews",
          38,
          "Exporting the thumbnail sheet and extracting preview images."
        );
        const buffer = await downloadPublicSpreadsheetBuffer({
          spreadsheetId: config.thumbnailSpreadsheetId
        });
        const imported = await importThumbnailWorkbookBuffer({
          buffer,
          filename: "online-thumbnail-sheet.xlsx",
          sourceKind: "thumbnail",
          blobToken: config.blobReadWriteToken,
          uploadId: `scan-${scanId}`,
          saveUploadRecord: false
        });
        counts.thumbnailPreviews = imported.importedCount;
        if (imported.importedCount > 0) {
          warnings.push(`Updated ${imported.importedCount} thumbnail previews from the online sheet.`);
        }
      } catch (error) {
        warnings.push(`Thumbnail previews skipped: ${error.message}`);
      }
    } else if (config.thumbnailSpreadsheetId && !config.blobReadWriteToken) {
      warnings.push("Embedded thumbnail previews skipped. Configure Vercel Blob to store sheet images.");
    }

    await progress(
      "thumbnail_previews",
      "Mapping thumbnail previews",
      48,
      "Matching stored preview images to thumbnail A/B/C rows."
    );
    const previewMap = await loadThumbnailPreviewMap();
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
    const enriched = await enrichWithYouTubeMetadata(records, config);
    counts.enrichedRows = enriched.records.length;
    warnings.push(...enriched.warnings);
    await progress(
      "save_runs",
      "Saving scan results",
      78,
      "Updating the shared queue cache without writing to Google Sheets."
    );
    await upsertScannedRuns({ records: enriched.records, scanId });
    await progress(
      "finish_signals",
      "Checking finish signals",
      88,
      "Comparing metadata and connector events against active tests."
    );
    const appliedEvents = await recordAppliedChangeEvents(enriched.records);
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
    await flagMissingCompletedRuns({ scanId, sourceKinds: scannedKinds });
    const queue = await listQueue();
    const summary = summarizeQueue(queue);
    await completeScanRun({ scanId, status: "ok", summary, warnings });
    return { ok: true, scanId, summary, warnings, scanned: records.length };
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
