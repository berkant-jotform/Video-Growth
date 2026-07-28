import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildHistoryExport } from "../lib/history-export.mjs";
import {
  buildAuditPackage,
  buildHistoryWorkbook
} from "../lib/history-export-workbook.js";

test("ExcelJS workbook has the required flat, typed, formula-free tabs", async () => {
  const exportData = sampleExportData();
  const buffer = await buildHistoryWorkbook(exportData);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "Summary",
    "Tests",
    "Variants",
    "Actions",
    "Video Context",
    "Data Quality",
    "Data Dictionary"
  ]);
  for (const name of ["Tests", "Variants", "Actions", "Video Context", "Data Quality"]) {
    const sheet = workbook.getWorksheet(name);
    assert.equal(sheet.views[0].ySplit, 1);
    assert.ok(sheet.autoFilter);
    assert.equal(Object.keys(sheet._merges || {}).length, 0);
    assert.equal(sheet.getRow(1).actualCellCount > 0, true);
  }

  const tests = workbook.getWorksheet("Tests");
  const headers = Object.fromEntries(
    tests.getRow(1).values.slice(1).map((value, index) => [value, index + 1])
  );
  assert.equal(typeof tests.getCell(2, headers.test_duration_hours).value, "number");
  assert.equal(tests.getCell(2, headers.video_title).value, "=Formula-looking title");
  const videoContext = workbook.getWorksheet("Video Context");
  const contextHeaders = Object.fromEntries(
    videoContext.getRow(1).values.slice(1).map((value, index) => [value, index + 1])
  );
  assert.equal(videoContext.rowCount - 1, exportData.datasets.videoContext.length);
  assert.equal(videoContext.getCell(2, contextHeaders.video_id).value, "video_1");
  assert.equal(videoContext.getCell(2, contextHeaders.definition).value, "hd");
  assert.equal(
    typeof videoContext.getCell(2, contextHeaders.duration_seconds).value,
    "number"
  );
  assert.equal(formulaCellCount(workbook), 0);
});

test("audit package includes the ExcelJS workbook, manifest, records, and checksums", async () => {
  const exportData = sampleExportData();
  const workbookBuffer = await buildHistoryWorkbook(exportData);
  const archive = await buildAuditPackage({
    exportData,
    workbookBuffer,
    workbookName: "history.xlsx"
  });
  const zip = await JSZip.loadAsync(archive);
  const names = Object.keys(zip.files).sort();

  assert.equal(names.includes("history.xlsx"), true);
  assert.equal(names.includes("manifest.json"), true);
  assert.equal(names.includes("checksums.sha256"), true);
  assert.equal(names.includes("audit/source_records.ndjson"), true);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.counts.logicalTests, 1);
  assert.equal(manifest.grains.videoContext, "one row per video_id");
  assert.equal(manifest.coverage.widerThresholdDays, 21);
  assert.equal(
    manifest.coverage.widerThresholdRule,
    "stored_start_age_days_greater_than_or_equal_to_threshold"
  );
  assert.equal(manifest.coverage.addedStartedWithoutFinishEvidence, 0);
  assert.deepEqual(
    manifest.variantReconciliation.testCountByExportedVariantRows,
    { "0": 0, "1": 0, "2": 1, "3": 0, other: 0 }
  );
  assert.equal(manifest.variantReconciliation.totalVariantRows, 2);
  const checksums = await zip.file("checksums.sha256").async("string");
  assert.match(checksums, /history\.xlsx/);
  assert.match(checksums, /audit\/finish_signals\.ndjson/);
});

function sampleExportData() {
  return buildHistoryExport({
    source: {
      tests: [{
        testId: "test_1",
        primaryTestRunId: "run_1",
        videoId: "video_1",
        testType: "title",
        sourceKind: "sheet",
        channel: "Jotform",
        videoTitle: "=Formula-looking title",
        lifecycleStatus: "finished",
        dataQualityFlag: "",
        result: "winner",
        resultEvidence: "studio_explicit",
        resultSemanticsVersion: "2026-07-28",
        explicitWinnerVariant: "B",
        startDate: "2026-07-01",
        finishDate: "2026-07-08",
        options: { A: "+Original", B: "-Alternative" },
        watchTimeShare: { A: 0.4, B: 0.6 },
        thumbnailPreviews: {}
      }],
      sourceRecords: [{
        testRunId: "run_1",
        testId: "test_1",
        videoId: "video_1",
        sourceKind: "sheet",
        spreadsheetId: "sheet_1",
        sheetName: "Tests",
        rowNumber: 2,
        status: "result_entered",
        startDate: "2026-07-01",
        finishDate: "2026-07-08",
        optionFingerprint: "fp",
        contentHash: "hash",
        lastSeenScanId: "scan_1",
        updatedAt: "2026-07-08T12:00:00.000Z"
      }],
      actions: [{
        actionId: "action_1",
        testId: "test_1",
        testRunId: "run_1",
        action: "B",
        actorName: "BG",
        note: "",
        createdAt: "2026-07-08T12:00:00.000Z"
      }],
      finishSignals: [{
        eventId: "event_1",
        testId: "test_1",
        testRunId: "run_1",
        videoId: "video_1",
        channel: "Jotform",
        source: "studio_bell",
        rawText: "A/B test won",
        matchedConfidence: "exact",
        processingStatus: "matched",
        result: "winner",
        resultEvidence: "studio_explicit",
        explicitWinnerVariant: "B",
        occurredAt: "2026-07-08T10:00:00.000Z",
        observedAt: "2026-07-08T10:05:00.000Z"
      }],
      videoContexts: [{
        videoId: "video_1",
        publishedAt: "2026-06-01T00:00:00.000Z",
        definition: "hd",
        durationSeconds: 120,
        liveArchive: false,
        madeForKids: false,
        privacyStatus: "public",
        contextFetchedAt: "2026-07-28T09:00:00.000Z"
      }],
      scanHistory: [],
      idHistory: [],
      aliases: []
    },
    request: { rows: "everything", contents: "workbook_audit" },
    actorName: "BG",
    generatedAtUtc: "2026-07-28T09:00:00.000Z"
  });
}

function formulaCellCount(workbook) {
  let count = 0;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value && typeof cell.value === "object" && "formula" in cell.value) {
          count += 1;
        }
      });
    });
  }
  return count;
}
