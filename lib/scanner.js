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
  upsertScannedRuns,
  listQueue,
  cleanupInlineThumbnailData
} from "@/lib/repository.js";

export async function runScan({ actorName = "system" } = {}) {
  const config = await getAppConfig();
  const scanId = await createScanRun({ actorName });
  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  const scannedKinds = [];

  try {
    await cleanupInlineThumbnailData();
    for (const source of [
      { sourceKind: "title", spreadsheetId: config.titleSpreadsheetId },
      { sourceKind: "thumbnail", spreadsheetId: config.thumbnailSpreadsheetId }
    ]) {
      if (!source.spreadsheetId) continue;
      scannedKinds.push(source.sourceKind);
      const sheets = await readSpreadsheetValues({
        spreadsheetId: source.spreadsheetId,
        config
      });
      records.push(
        ...parseWorkbookRecords({
          spreadsheetId: source.spreadsheetId,
          sourceKind: source.sourceKind,
          sheets,
          today
        })
      );
    }

    if (config.thumbnailSpreadsheetId && config.blobReadWriteToken) {
      try {
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
        if (imported.importedCount > 0) {
          warnings.push(`Updated ${imported.importedCount} thumbnail previews from the online sheet.`);
        }
      } catch (error) {
        warnings.push(`Thumbnail previews skipped: ${error.message}`);
      }
    } else if (config.thumbnailSpreadsheetId && !config.blobReadWriteToken) {
      warnings.push("Embedded thumbnail previews skipped. Configure Vercel Blob to store sheet images.");
    }

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

    const enriched = await enrichWithYouTubeMetadata(records, config);
    warnings.push(...enriched.warnings);
    await upsertScannedRuns({ records: enriched.records, scanId });
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
