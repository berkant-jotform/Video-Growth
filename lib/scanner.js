import { getAppConfig } from "@/lib/config.js";
import { inspectWorkbookSheets, parseWorkbookRecords } from "@/lib/domain.mjs";
import { downloadPublicSpreadsheetBuffer, readSpreadsheetValues } from "@/lib/sheets.js";
import { importThumbnailWorkbookBuffer } from "@/lib/uploads.js";
import { enrichWithYouTubeMetadata } from "@/lib/youtube.js";
import { enrichThumbnailMatches } from "@/lib/thumbnail-match.js";
import { inactiveSourceTabs, sourceTabKey, sourceTabPolicy } from "@/lib/source-tabs.mjs";
import {
  completeScanRun,
  completeCancelledScanRun,
  createScanRun,
  assertScanActive,
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
  consolidateDuplicateAppManagedRuns,
  quarantineWeakAppManagedRuns,
  reconcileAppManagedRunsWithSheets,
  reconcileLegacyYearlessDateRuns,
  reconcileExactMaterialIdentitySplits,
  repairDateIdentityAliases,
  auditDataIntegrity,
  applySourceTabModes,
  revalidateMatchedFinishEvents,
  rematchUnmatchedFinishEvents
} from "@/lib/repository.js";
import { isScanCancelledError } from "@/lib/scan-cancellation.mjs";
import { formatDateOnly } from "@/lib/date-only.mjs";
import {
  matchesPostEnrichmentScanFilters,
  matchesPreEnrichmentScanFilters,
  normalizeChannelFilters
} from "@/lib/scan-scope.mjs";

export async function runScan({ actorName = "system", scanId: requestedScanId = "", channel = "all", channels = [], testType = "all", refreshThumbnails = false } = {}) {
  const config = await getAppConfig();
  const scanId = await createScanRun({ actorName, requestedScanId });
  const warnings = [];
  const notices = [];
  const today = formatDateOnly(new Date());
  const records = [];
  const scannedKinds = [];
  const attemptedSources = [];
  const successfulSources = [];
  const sourceTabModes = [];
  const discoveredSourceTabKeys = new Set();
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
  counts.sourceHealth = [];

  let currentStage = "starting";
  const progress = (stage, label, percent, detail = "") => {
    currentStage = stage;
    return updateScanProgress({ scanId, stage, label, percent, detail, counts });
  };
  const timed = async (key, fn) => {
    const stageStart = Date.now();
    try {
      await assertScanActive(scanId);
      const result = await fn();
      await assertScanActive(scanId);
      return result;
    } catch (error) {
      if (!error.scanStage) error.scanStage = key;
      throw error;
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
      attemptedSources.push(source.sourceKind);
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
            preferPublicCsv: source.sourceKind === "thumbnail",
            skipSheetNames: inactiveSourceTabs(
              config.sourceTabPolicies,
              config.excludedSheetTabs,
              source.sourceKind
            ).map((item) => item.sheetName)
          })
        );
      } catch (error) {
        warnings.push(`${source.sourceKind} sheet was not refreshed: ${error.message}`);
        counts.sourceHealth.push({
          sourceKind: source.sourceKind,
          status: "failed",
          message: error.message
        });
        await recordDiagnosticLog({
          category: "sheet_read",
          severity: "error",
          message: `${source.sourceKind} sheet could not be read`,
          actorName,
          context: { sourceKind: source.sourceKind, spreadsheetId: source.spreadsheetId, error: error.message }
        });
        continue;
      }
      successfulSources.push(source.sourceKind);
      if (!sheets.readIncomplete) scannedKinds.push(source.sourceKind);
      counts.sourceHealth.push({
        sourceKind: source.sourceKind,
        status: sheets.readIncomplete ? "partial" : "fresh",
        tabCount: sheets.length,
        missingLinkedWorkbooks: (sheets.missingLinkedWorkbooks || []).length
      });
      warnings.push(...(sheets.readWarnings || []));
      const allSheetInspection = inspectWorkbookSheets({ sourceKind: source.sourceKind, sheets });
      const inactiveTitles = new Set();
      for (const sheet of allSheetInspection) {
        const policy = sourceTabPolicy(
          { sourceKind: source.sourceKind, sheetName: sheet.title },
          config.sourceTabPolicies,
          config.excludedSheetTabs
        );
        sourceTabModes.push({
          sourceKind: source.sourceKind,
          spreadsheetId: sheet.spreadsheetId || source.spreadsheetId,
          sheetName: sheet.title,
          mode: policy.mode
        });
        if (policy.mode !== "active") inactiveTitles.add(sheet.title);
      }
      const includedSheets = inactiveTitles.size
        ? sheets.filter((sheet) => !inactiveTitles.has(sheet.title))
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
      const monitoringRowsByTab = parsed.reduce((map, record) => {
        if (isTerminalSheetStatus(record.status)) return map;
        const key = String(record.sheetName || "");
        map.set(key, (map.get(key) || 0) + 1);
        return map;
      }, new Map());
      for (const sheet of allSheetInspection) {
        discoveredSourceTabKeys.add(sourceTabKey(source.sourceKind, sheet.title));
        const policy = sourceTabPolicy(
          { sourceKind: source.sourceKind, sheetName: sheet.title },
          config.sourceTabPolicies,
          config.excludedSheetTabs
        );
        let testRows = parsedRowsByTab.get(sheet.title) || 0;
        if (policy.mode !== "active" && sheet.recognized) {
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
          spreadsheetId: sheet.spreadsheetId || source.spreadsheetId,
          title: sheet.title,
          recognized: Boolean(sheet.recognized),
          likelyTestData: Boolean(sheet.likelyTestData),
          hasContent: Boolean(sheet.hasContent || sheet.skippedByPolicy),
          linkedFrom: sheet.linkedFrom || "",
          skippedByPolicy: Boolean(sheet.skippedByPolicy),
          mode: policy.mode,
          excluded: policy.mode !== "active",
          exclusionSource: policy.source,
          exclusionReason: policy.reason,
          testRows,
          monitoringRows: monitoringRowsByTab.get(sheet.title) || 0,
          readyToArchive: policy.mode === "active" && testRows > 0 && (monitoringRowsByTab.get(sheet.title) || 0) === 0
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
      const scoped = parsed.filter((record) => matchesPreEnrichmentScanFilters(record, filters));
      records.push(...scoped);
      if (source.sourceKind === "title") counts.titleRows = parsed.length;
      if (source.sourceKind === "thumbnail") counts.thumbnailRows = parsed.length;
      counts.totalRows = records.length;
      counts.filteredRows += Math.max(0, parsed.length - scoped.length);
    }

    if (!attemptedSources.length) {
      const error = new Error("No spreadsheet is configured for the selected scan. Add the sheet in Settings, then try again.");
      error.status = 503;
      throw error;
    }
    if (!successfulSources.length) {
      const error = new Error("No selected spreadsheet source could be refreshed. The previous queue was preserved; review the source warnings and try again.");
      error.status = 503;
      throw error;
    }

    const completelyReadKinds = new Set(scannedKinds);
    const stalePolicies = config.sourceTabPolicies.filter(
      (item) => completelyReadKinds.has(item.sourceKind) && !discoveredSourceTabKeys.has(sourceTabKey(item.sourceKind, item.sheetName))
    );
    counts.staleTabPolicies = stalePolicies.length;
    if (stalePolicies.length) {
      warnings.push(
        `${stalePolicies.length} saved tab polic${stalePolicies.length === 1 ? "y no longer matches" : "ies no longer match"} a current tab: ${stalePolicies.slice(0, 4).map((item) => `"${item.sheetName}"`).join(", ")}${stalePolicies.length > 4 ? ", ..." : ""}. The tab may have been renamed; new tabs remain Active until reviewed in Settings.`
      );
    }

    for (const source of [
      { sourceKind: "title", spreadsheetId: config.titleSpreadsheetId },
      { sourceKind: "thumbnail", spreadsheetId: config.thumbnailSpreadsheetId }
    ]) {
      if (!source.spreadsheetId) continue;
      for (const item of inactiveSourceTabs(config.sourceTabPolicies, config.excludedSheetTabs, source.sourceKind)) {
        sourceTabModes.push({ ...item, spreadsheetId: source.spreadsheetId });
      }
    }
    counts.tabModeChanges = await timed("tab_modes", () => applySourceTabModes(sourceTabModes));

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
            excludedSheetNames: inactiveSourceTabs(config.sourceTabPolicies, config.excludedSheetTabs, "thumbnail").map((item) => item.sheetName),
            saveUploadRecord: false
          })
        );
        counts.thumbnailPreviews = imported.importedCount;
        if (imported.importedCount > 0) {
          notices.push(`Updated ${imported.importedCount} thumbnail previews from the online sheet.`);
        }
      } catch (error) {
        warnings.push(
          error.status === 413
            ? "Online thumbnail rebuild cannot split a large Google workbook by tab. Upload one or more active-tab XLSX snapshots from Uploads; the normal test-row scan still completed."
            : `Thumbnail image rebuild skipped: ${error.message} Test rows were still scanned.`
        );
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
    const scopedRecords = enriched.records.filter((record) =>
      matchesPostEnrichmentScanFilters(record, filters)
    );
    counts.filteredRows += Math.max(0, enriched.records.length - scopedRecords.length);
    counts.enrichedRows = scopedRecords.length;
    warnings.push(...enriched.warnings);
    const thumbnailMatches = await timed("thumbnail_compare", () =>
      enrichThumbnailMatches(scopedRecords, config)
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
        records: scopedRecords,
        scanId,
        onProgress: ({ saved, total }) => {
          counts.savedRows = saved;
          currentStage = "save_runs";
          return updateScanProgress({
            scanId,
            stage: "save_runs",
            label: "Saving scan results",
            percent: 78 + Math.min(8, Math.floor((saved / Math.max(1, total)) * 8)),
            detail: `Saved ${saved} of ${total} rows into the shared queue cache.`,
            counts,
            // A write batch is a safe unit. Finish all batches so cancellation
            // cannot leave a half-written source refresh, then stop at timed().
            deferCancellation: true
          });
        }
      })
    );
    const reconciledManagedRuns = await timed("reconcile_app_registry", () => reconcileAppManagedRunsWithSheets());
    counts.reconciledManagedRuns = reconciledManagedRuns.length;
    if (reconciledManagedRuns.length) {
      notices.push(`Linked ${reconciledManagedRuns.length} app-managed test${reconciledManagedRuns.length === 1 ? "" : "s"} to newly available sheet rows.`);
    }
    const reconciledExactMaterials = await timed("reconcile_exact_material", () =>
      reconcileExactMaterialIdentitySplits()
    );
    counts.reconciledExactMaterialTests = reconciledExactMaterials.mappings.length;
    counts.ambiguousExactMaterialTests = reconciledExactMaterials.ambiguous.length;
    if (counts.reconciledExactMaterialTests) {
      notices.push(
        `Reconciled ${counts.reconciledExactMaterialTests} split logical test identit${counts.reconciledExactMaterialTests === 1 ? "y" : "ies"}.`
      );
    }
    if (counts.ambiguousExactMaterialTests) {
      warnings.push(
        `${counts.ambiguousExactMaterialTests} exact-match identity group${counts.ambiguousExactMaterialTests === 1 ? " has" : "s have"} conflicting evidence and was left unchanged.`
      );
    }
    const reconciledLegacyDates = await timed("reconcile_legacy_dates", () =>
      reconcileLegacyYearlessDateRuns()
    );
    counts.reconciledLegacyDateRuns = reconciledLegacyDates.mappings.length;
    counts.ambiguousLegacyDateRuns = reconciledLegacyDates.ambiguous.length;
    counts.unresolvedLegacyDateRuns = reconciledLegacyDates.unresolvedActive;
    if (counts.reconciledLegacyDateRuns) {
      notices.push(
        `Reconciled ${counts.reconciledLegacyDateRuns} legacy yearless-date duplicate${counts.reconciledLegacyDateRuns === 1 ? "" : "s"}.`
      );
    }
    if (counts.unresolvedLegacyDateRuns) {
      warnings.push(
        `${counts.unresolvedLegacyDateRuns} active legacy yearless-date row${counts.unresolvedLegacyDateRuns === 1 ? " has" : "s have"} no deterministic dated twin and was left unchanged.`
      );
    }
    const repairedDateAliases = await timed("repair_date_aliases", () => repairDateIdentityAliases());
    counts.repairedDateAliases = repairedDateAliases.missing + repairedDateAliases.stale;
    counts.ambiguousDateAliases = repairedDateAliases.ambiguous;
    if (counts.repairedDateAliases) {
      notices.push(
        `Repaired ${counts.repairedDateAliases} timezone-shifted or missing date identit${counts.repairedDateAliases === 1 ? "y" : "ies"}.`
      );
    }
    if (counts.ambiguousDateAliases) {
      warnings.push(
        `${counts.ambiguousDateAliases} date alias${counts.ambiguousDateAliases === 1 ? " is" : "es are"} shared by multiple tests and was disabled instead of guessed.`
      );
    }
    const integrity = await timed("integrity_check", () => auditDataIntegrity());
    counts.integrity = integrity;
    const integrityProblems = Object.entries(integrity).filter(([, value]) => Number(value) > 0);
    if (integrityProblems.length) {
      warnings.push(
        `Data integrity check found ${integrityProblems.map(([key, value]) => `${value} ${humanizeIntegrityKey(key)}`).join(", ")}. No uncertain records were changed.`
      );
    }
    await progress(
      "finish_signals",
      "Checking finish signals",
      88,
      "Comparing metadata and connector events against active tests."
    );
    const appliedEvents = await timed("finish_signals", () => recordAppliedChangeEvents(scopedRecords));
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
    const consolidatedManagedRuns = await timed("consolidate_app_registry", () =>
      consolidateDuplicateAppManagedRuns()
    );
    counts.consolidatedManagedRuns = consolidatedManagedRuns.reduce(
      (total, plan) => total + plan.duplicateIds.length,
      0
    );
    if (counts.consolidatedManagedRuns) {
      notices.push(
        `Consolidated ${counts.consolidatedManagedRuns} duplicate Studio-only record${counts.consolidatedManagedRuns === 1 ? "" : "s"}.`
      );
    }
    const quarantinedManagedRuns = await timed("quarantine_incomplete_signals", () =>
      quarantineWeakAppManagedRuns()
    );
    counts.quarantinedSignals = quarantinedManagedRuns.ignoredEvents;
    counts.retiredWeakManagedRuns = quarantinedManagedRuns.retiredRuns;
    if (quarantinedManagedRuns.ignoredEvents || quarantinedManagedRuns.retiredRuns) {
      notices.push(
        `Quarantined ${quarantinedManagedRuns.ignoredEvents} incomplete Studio signal${quarantinedManagedRuns.ignoredEvents === 1 ? "" : "s"} and retired ${quarantinedManagedRuns.retiredRuns} unsupported card${quarantinedManagedRuns.retiredRuns === 1 ? "" : "s"}.`
      );
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
      notices.push(`Collapsed ${counts.mergedDuplicateRows} repeated source row${counts.mergedDuplicateRows === 1 ? "" : "s"} into one card per logical test for display.`);
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
    return { ok: true, scanId, summary, warnings, notices, scanned: scopedRecords.length, timings, partialScan };
  } catch (caughtError) {
    let error = caughtError;
    if (!isScanCancelledError(error)) {
      try {
        await assertScanActive(scanId);
      } catch (cancellationError) {
        if (isScanCancelledError(cancellationError)) error = cancellationError;
      }
    }
    if (isScanCancelledError(error)) {
      timings.total = Date.now() - startedAt;
      await completeCancelledScanRun({
        scanId,
        warnings,
        counts: { ...counts, notices },
        timings,
        actorName
      });
      await recordDiagnosticLog({
        category: "scan",
        severity: "info",
        message: "Scan stopped by reviewer",
        actorName,
        context: {
          scanId,
          stage: error.scanStage || currentStage,
          filters,
          counts,
          timings,
          partialScan
        }
      });
      return {
        ok: false,
        cancelled: true,
        scanId,
        message: "Scan stopped safely. The existing queue remains available.",
        warnings,
        notices,
        timings,
        partialScan
      };
    }
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
        errorCode: error.code || "",
        identityConflict: error.identityConflict || null,
        stage: error.scanStage || currentStage,
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

function isTerminalSheetStatus(status) {
  return ["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(String(status || ""));
}

function humanizeIntegrityKey(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}
