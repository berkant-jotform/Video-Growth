import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { getSql } from "../lib/db.js";
import { buildHistoryExport, EXPORT_RESULT_VALUES } from "../lib/history-export.mjs";
import { loadHistoryExportSource } from "../lib/history-export-repository.js";
import {
  buildAuditPackage,
  buildHistoryWorkbook
} from "../lib/history-export-workbook.js";
import { fetchYouTubeVideoContexts } from "../lib/youtube.js";

const outputArgument = process.argv.slice(2).find((item) => !item.startsWith("--"));
const refreshYouTube = process.argv.includes("--with-youtube");
const outputDir = path.resolve(outputArgument || "/tmp/youtube-ab-history-export-verification");
const generatedAtUtc = new Date().toISOString();
let source = await loadHistoryExportSource({ skipSchema: true });
if (refreshYouTube) {
  const youtubeApiKey = process.env.YOUTUBE_API_KEY || await storedYouTubeApiKey();
  assert.ok(youtubeApiKey, "YOUTUBE_API_KEY is required with --with-youtube");
  const videoIds = Array.from(
    new Set(source.tests.map((test) => test.videoId).filter(Boolean))
  );
  const contexts = await fetchYouTubeVideoContexts(videoIds, youtubeApiKey);
  source = { ...source, videoContexts: contexts };
}
const exportData = buildHistoryExport({
  source,
  request: {
    rows: "everything",
    contents: "workbook_audit",
    includeReviewerNotes: false,
    filters: { channel: "all", testType: "all", action: "all", search: "" }
  },
  actorName: "Export verifier",
  generatedAtUtc
});

verifyDataContract(exportData);

const workbookBuffer = await buildHistoryWorkbook(exportData);
const workbookName = "YT_AB_Tests_verification.xlsx";
const auditBuffer = await buildAuditPackage({
  exportData,
  workbookBuffer,
  workbookName
});

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, workbookName), workbookBuffer);
await fs.writeFile(path.join(outputDir, "YT_AB_Tests_verification_with_audit.zip"), auditBuffer);

const workbookSummary = await verifyWorkbook(workbookBuffer, exportData);
const auditSummary = await verifyAuditPackage(auditBuffer, workbookName, exportData);

console.log(JSON.stringify({
  ok: true,
  generatedAtUtc,
  outputDir,
  youtubeContextRefreshed: refreshYouTube,
  counts: {
    logicalTests: exportData.datasets.tests.length,
    sheetBackedLogicalTests: exportData.coverage.population.sheetBackedLogicalTests,
    appManagedLogicalTests: exportData.coverage.population.appManagedLogicalTests,
    sourceRecords: exportData.datasets.sourceRecords.length,
    variants: exportData.datasets.variants.length,
    actions: exportData.datasets.actions.length,
    finishSignals: exportData.datasets.finishSignals.length,
    videos: exportData.datasets.videoContext.length
  },
  coverage: {
    strictEligibleN: exportData.coverage.population.strictEligibleN,
    widerEligibleN: exportData.coverage.population.widerEligibleN,
    overThreeWeeksCount: exportData.coverage.overThreeWeeksCount,
    strict: compactCoverage(exportData.coverage.strict),
    wider: compactCoverage(exportData.coverage.wider)
  },
  dateSpan: exportData.preview.dateSpan,
  warnings: exportData.preview.warnings.map((item) => item.message),
  workbook: workbookSummary,
  audit: auditSummary
}, null, 2));

function verifyDataContract(data) {
  assert.equal(
    data.coverage.population.sheetBackedLogicalTests +
      data.coverage.population.appManagedLogicalTests,
    data.datasets.tests.length
  );
  assert.equal(
    data.datasets.tests.some(
      (test) => test.result === "winner" && test.result_evidence === "inferred_legacy"
    ),
    false
  );
  assert.equal(
    data.datasets.tests.every((test) => EXPORT_RESULT_VALUES.includes(test.result)),
    true
  );

  const testIds = new Set(data.datasets.tests.map((test) => test.test_id));
  const videoIds = new Set(data.datasets.tests.map((test) => test.video_id).filter(Boolean));
  assert.equal(data.datasets.variants.every((row) => testIds.has(row.test_id)), true);
  assert.equal(data.datasets.actions.every((row) => testIds.has(row.test_id)), true);
  assert.equal(
    data.datasets.videoContext.every((row) => videoIds.has(row.video_id)),
    true
  );
  assert.equal(
    data.datasets.variants.some(
      (row) => row.is_youtube_winner && !["A", "B", "C"].includes(row.variant_slot)
    ),
    false
  );
}

async function verifyWorkbook(buffer, data) {
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
    assert.equal(sheet.views[0]?.ySplit, 1);
    assert.ok(sheet.autoFilter);
    assert.equal(Object.keys(sheet._merges || {}).length, 0);
  }
  assert.equal(formulaCellCount(workbook), 0);

  const testsSheet = workbook.getWorksheet("Tests");
  const headers = Object.fromEntries(
    testsSheet.getRow(1).values.slice(1).map((value, index) => [value, index + 1])
  );
  assert.equal(testsSheet.rowCount - 1, data.datasets.tests.length);
  for (const header of [
    "test_duration_hours",
    "detection_delay_hours",
    "review_response_hours",
    "total_cycle_hours",
    "days_open"
  ]) {
    assert.ok(headers[header], `${header} must exist`);
    const values = [];
    for (let row = 2; row <= testsSheet.rowCount; row += 1) {
      const value = testsSheet.getCell(row, headers[header]).value;
      if (value !== null && value !== "") values.push(value);
    }
    assert.equal(values.every((value) => typeof value === "number"), true);
  }
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    sheetRows: Object.fromEntries(
      workbook.worksheets.map((sheet) => [sheet.name, Math.max(0, sheet.rowCount - 1)])
    ),
    formulas: 0
  };
}

async function verifyAuditPackage(buffer, workbookName, data) {
  const zip = await JSZip.loadAsync(buffer);
  const required = [
    workbookName,
    "manifest.json",
    "checksums.sha256",
    "audit/source_records.ndjson",
    "audit/finish_signals.ndjson",
    "audit/scan_history.ndjson",
    "audit/id_history.ndjson",
    "audit/identity_aliases.ndjson"
  ];
  assert.equal(required.every((name) => Boolean(zip.file(name))), true);
  const checksums = await zip.file("checksums.sha256").async("string");
  for (const name of required.filter((name) => name !== "checksums.sha256")) {
    const bytes = await zip.file(name).async("nodebuffer");
    assert.match(checksums, new RegExp(`${sha256(bytes)}  ${escapeRegex(name)}`));
  }
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.coverage.widerThresholdDays, 21);
  assert.equal(
    manifest.coverage.widerThresholdRule,
    "stored_start_age_days_greater_than_or_equal_to_threshold"
  );
  assert.equal(
    manifest.coverage.addedStartedWithoutFinishEvidence,
    data.coverage.overThreeWeeksCount
  );
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    entries: Object.keys(zip.files).filter((name) => !zip.files[name].dir).length,
    checksumsVerified: true
  };
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

function compactCoverage(rows) {
  return Object.fromEntries(
    rows.map((item) => [
      item.key,
      {
        includedN: item.includedN,
        eligibleN: item.eligibleN,
        coverageRate: item.coverageRate,
        band: item.band
      }
    ])
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function storedYouTubeApiKey() {
  const sql = getSql();
  const rows = await sql`
    SELECT value
    FROM app_settings
    WHERE key = 'YOUTUBE_API_KEY'
    LIMIT 1
  `;
  return rows[0]?.value || "";
}
