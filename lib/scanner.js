import { getAppConfig } from "@/lib/config.js";
import { canonicalChannelName } from "@/lib/channels.mjs";
import { inspectWorkbookSheets, parseWorkbookRecords } from "@/lib/domain.mjs";
import { downloadPublicSpreadsheetBuffer, readSpreadsheetValues } from "@/lib/sheets.js";
import { importThumbnailWorkbookBuffer } from "@/lib/uploads.js";
import { enrichWithYouTubeMetadata } from "@/lib/youtube.js";
import { enrichThumbnailMatches } from "@/lib/thumbnail-match.js";
import { sourceTabExclusion } from "@/lib/source-tabs.mjs";
import {
  completeScanRun,
  createScanRun,
  reconcileMissingRuns,
  loadThumbnailPreviewMap,
  previewKey,
  summarizeQueue,
  updateScanProgress,
  upsertScannedRuns,
  listQueue,
  cleanupInlineThumbnailData,
  recordAppliedChangeEvents,
  recordDiagnosticLog,
  reconcileAppManagedRunsWithSheets,
  revalidateMatchedFinishEvents,
  rematchUnmatchedFinishEvents
} from "@/lib/repository.js";

export async function runScan({ actorName = "system", channel = "all", channels = [], testType = "all", refreshThumbnails = false } = {}) {
  const config = await getAppConfig();
  const scanId = await createScanRun({ actorName });
  const warnings = [];
  const notices = [];
  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  const scannedKinds = [];
  const timings = {};
  const startedAt = Date.now();
  const channelFilters = normalizeChannelFilters(channels.length ? channels : channel);
  const filters = {
    channels: channelFilters,
    testType: testType && testType !== "all" ? testType : ""
  };
  const partialScan = Boolean(filters.channels.length || filters.testType);
  const counts = {
    titleRows: 0,
    thumbnailRows: 0,
    totalRows: 0,
    filteredRows: 0,
    thumbnailPreviews: 0,
    enrichedRows: 0,
    appliedSignals: 0,
    rematchedSignals: 0,
    timings
  };
  counts.sheetTabs = [];

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
    await recordDiagnosticLog({
      category: "scan",
      severity: "info",
      message: "Scan started",
      actorName,
      context: { scanId, filters, refreshThumbnails }
    });
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
      await progress(
        "read_sheets",
        `Reading ${source.sourceKind} sheet`,
        source.sourceKind === "title" ? 12 : 24,
        `Fetching ${source.sourceKind} test rows from Google Sheets.`
      );
      let sheets;
      try {
        sheets = await timed(`read_${source.sourceKind}`, () =>
          readSpreadsheetValues({
            spreadsheetId: source.spreadsheetId,
            config,
            // Thumbnail workbooks can contain hundreds of megabytes of embedded
            // images. Queue data only needs cell values; previews are refreshed
            // separately when explicitly requested.
            preferPublicCsv: source.sourceKind === "thumbnail"
          })
        );
      } catch (error) {
        warnings.push(`${source.sourceKind} sheet was not refreshed: ${error.message}`);
        await recordDiagnosticLog({
          category: "sheet_read",
          severity: "error",
          message: `${source.sourceKind} sheet could not be read`,
          actorName,
          context: { sourceKind: source.sourceKind, spreadsheetId: source.spreadsheetId, error: error.message }
        });
        continue;
      }
      if (!sheets.readIncomplete) scannedKinds.push(source.sourceKind);
      warnings.push(...(sheets.readWarnings || []));
      const allSheetInspection = inspectWorkbookSheets({ sourceKind: source.sourceKind, sheets });
      const excludedTitles = new Set();
      for (const sheet of allSheetInspection) {
        const exclusion = sourceTabExclusion(
          { sourceKind: source.sourceKind, sheetName: sheet.title },
          config.excludedSheetTabs
        );
        if (exclusion.excluded) excludedTitles.add(sheet.title);
      }
      const includedSheets = excludedTitles.size
        ? sheets.filter((sheet) => !excludedTitles.has(sheet.title))
        : sheets;
      const parsed = parseWorkbookRecords({
        spreadsheetId: source.spreadsheetId,
        sourceKind: source.sourceKind,
        sheets: includedSheets,
        today
      });
      const parsedRowsByTab = parsed.reduce((map, record) => {
        const key = String(record.sheetName || "");
        map.set(key, (map.get(key) || 0) + 1);
        return map;
      }, new Map());
      for (const sheet of allSheetInspection) {
        const exclusion = sourceTabExclusion(
          { sourceKind: source.sourceKind, sheetName: sheet.title },
          config.excludedSheetTabs
        );
        let testRows = parsedRowsByTab.get(sheet.title) || 0;
        if (exclusion.excluded && sheet.recognized) {
          const sourceSheet = sheets.find((item) => item.title === sheet.title);
          if (sourceSheet) {
            testRows = parseWorkbookRecords({
              spreadsheetId: source.spreadsheetId,
              sourceKind: source.sourceKind,
              sheets: [sourceSheet],
              today
            }).length;
          }
        }
        counts.sheetTabs.push({
          sourceKind: source.sourceKind,
          spreadsheetId: source.spreadsheetId,
          title: sheet.title,
          recognized: Boolean(sheet.recognized),
          likelyTestData: Boolean(sheet.likelyTestData),
          hasContent: Boolean(sheet.hasContent),
          excluded: exclusion.excluded,
          exclusionSource: exclusion.source,
          exclusionReason: exclusion.reason,
          testRows
        });
      }
      const sheetInspection = inspectWorkbookSheets({ sourceKind: source.sourceKind, sheets: includedSheets });
      const skippedTabs = sheetInspection.filter((sheet) => sheet.hasContent && !sheet.recognized && sheet.likelyTestData);
      const auxiliaryTabs = sheetInspection.filter((sheet) => sheet.hasContent && !sheet.recognized && !sheet.likelyTestData);
      if (skippedTabs.length) {
        warnings.push(
          `${source.sourceKind} sheet has ${skippedTabs.length} tab${skippedTabs.length === 1 ? "" : "s"} that look like test data but do not have recognizable A/B headers: ${skippedTabs.slice(0, 4).map((item) => `"${item.title}"`).join(", ")}${skippedTabs.length > 4 ? ", ..." : ""}.`
        );
        await recordDiagnosticLog({
          category: "sheet_parse",
          severity: "warning",
          message: "Non-empty sheet tabs skipped",
          actorName,
          context: {
            sourceKind: source.sourceKind,
            spreadsheetId: source.spreadsheetId,
            skippedTabs: skippedTabs.slice(0, 12),
            ignoredAuxiliaryTabs: auxiliaryTabs.slice(0, 12)
          }
        });
      }
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
          notices.push(`Updated ${imported.importedCount} thumbnail previews from the online sheet.`);
        }
      } catch (error) {
        warnings.push(`Thumbnail image rebuild skipped: ${error.message} Test rows were still scanned.`);
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
    const thumbnailMatches = await timed("thumbnail_compare", () =>
      enrichThumbnailMatches(enriched.records, config)
    );
    counts.thumbnailMatches = thumbnailMatches.matched;
    warnings.push(...thumbnailMatches.warnings);
    await progress(
      "save_runs",
      "Saving scan results",
      78,
      "Updating the shared queue cache without writing to Google Sheets."
    );
    await timed("save_runs", () =>
      upsertScannedRuns({
        records: enriched.records,
        scanId,
        onProgress: ({ saved, total }) => {
          counts.savedRows = saved;
          return progress(
            "save_runs",
            "Saving scan results",
            78 + Math.min(8, Math.floor((saved / Math.max(1, total)) * 8)),
            `Saved ${saved} of ${total} rows into the shared queue cache.`
          );
        }
      })
    );
    const reconciledManagedRuns = await timed("reconcile_app_registry", () => reconcileAppManagedRunsWithSheets());
    counts.reconciledManagedRuns = reconciledManagedRuns.length;
    if (reconciledManagedRuns.length) {
      notices.push(`Linked ${reconciledManagedRuns.length} app-managed test${reconciledManagedRuns.length === 1 ? "" : "s"} to newly available sheet rows.`);
    }
    await progress(
      "finish_signals",
      "Checking finish signals",
      88,
      "Comparing metadata and connector events against active tests."
    );
    const appliedEvents = await timed("finish_signals", () => recordAppliedChangeEvents(enriched.records));
    counts.appliedSignals = appliedEvents.length;
    if (appliedEvents.length) {
      notices.push(`Observed ${appliedEvents.length} possible applied B/C metadata changes.`);
    }
    const revalidatedEvents = await timed("revalidate_signals", () =>
      revalidateMatchedFinishEvents({ youtubeApiKey: config.youtubeApiKey })
    );
    counts.revalidatedSignals = revalidatedEvents.length;
    if (revalidatedEvents.length) {
      notices.push(`Revalidated ${revalidatedEvents.length} uncertain or noisy Studio signals.`);
    }
    const rematchedEvents = await timed("rematch_signals", () => rematchUnmatchedFinishEvents({ youtubeApiKey: config.youtubeApiKey }));
    counts.rematchedSignals = rematchedEvents.length;
    if (rematchedEvents.length) {
      notices.push(`Auto-matched ${rematchedEvents.length} previously unmatched Studio finish signals.`);
    }
    await progress(
      "finish_signals",
      "Finalizing queue",
      94,
      "Marking missing rows, refreshing counts, and preparing the dashboard."
    );
    if (!partialScan) {
      await timed("reconcile_missing", () => reconcileMissingRuns({ scanId, sourceKinds: scannedKinds }));
    }
    const queue = await timed("refresh_queue", () => listQueue());
    counts.mergedDuplicateRows = queue.reduce((sum, run) => sum + Number(run.duplicateCount || 0), 0);
    if (counts.mergedDuplicateRows) {
      notices.push(`Merged ${counts.mergedDuplicateRows} duplicate sheet row${counts.mergedDuplicateRows === 1 ? "" : "s"} into their original test runs.`);
    }
    const summary = summarizeQueue(queue);
    counts.notices = notices;
    await completeScanRun({ scanId, status: "ok", summary, warnings, counts, timings });
    await recordDiagnosticLog({
      category: "scan",
      severity: warnings.length ? "warning" : "info",
      message: "Scan completed",
      actorName,
      context: {
        scanId,
        summary,
        warnings,
        notices,
        counts,
        timings,
        partialScan
      }
    });
    return { ok: true, scanId, summary, warnings, notices, scanned: records.length, timings, partialScan };
  } catch (error) {
    await completeScanRun({
      scanId,
      status: "failed",
      summary: { error: error.message },
      warnings,
      counts: { ...counts, notices },
      timings
    });
    await recordDiagnosticLog({
      category: "scan",
      severity: "error",
      message: "Scan failed",
      actorName,
      context: {
        scanId,
        error: error.message,
        stack: error.stack,
        warnings,
        counts,
        timings,
        partialScan
      }
    });
    throw error;
  }
}

function matchesScanFilters(record, filters) {
  if (filters.testType && record.testType !== filters.testType) return false;
  if (filters.channels?.length) {
    const candidates = [record.channel, record.sheetName, record.youtubeChannelTitle]
      .map(normalizeText)
      .filter(Boolean);
    if (!filters.channels.some((channel) => candidates.includes(normalizeText(channel)))) return false;
  }
  return true;
}

function normalizeChannelFilters(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "all");
}

function normalizeText(value) {
  return String(canonicalChannelName(value) || value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
