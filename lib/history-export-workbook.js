import crypto from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  HISTORY_EXPORT_SCHEMA_VERSION,
  HISTORY_EXPORT_WIDER_THRESHOLD_DAYS,
  historyExportFilename,
  safeSpreadsheetText
} from "./history-export.mjs";

const DATA_SHEETS = [
  ["Tests", "tests"],
  ["Variants", "variants"],
  ["Actions", "actions"],
  ["Video Context", "videoContext"],
  ["Data Quality", "dataQuality"]
];

export async function buildHistoryExportFile(exportData) {
  const workbookBuffer = await buildHistoryWorkbook(exportData);
  const workbookName = historyExportFilename({
    tests: exportData.datasets.tests,
    filters: exportData.identity.filters,
    generatedAtUtc: exportData.identity.generatedAtUtc,
    requestHash: exportData.identity.requestHash
  });
  if (exportData.identity.contents === "workbook") {
    return {
      buffer: workbookBuffer,
      fileName: workbookName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      checksum: sha256(workbookBuffer)
    };
  }
  const zipBuffer = await buildAuditPackage({
    exportData,
    workbookBuffer,
    workbookName
  });
  return {
    buffer: zipBuffer,
    fileName: workbookName.replace(/\.xlsx$/i, "_with_audit.zip"),
    contentType: "application/zip",
    checksum: sha256(zipBuffer)
  };
}

export async function buildHistoryWorkbook(exportData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YouTube A/B Tests";
  workbook.created = new Date(exportData.identity.generatedAtUtc);
  workbook.modified = new Date(exportData.identity.generatedAtUtc);
  workbook.subject = "YouTube A/B test history and analysis export";
  workbook.company = "Jotform";
  workbook.calcProperties.fullCalcOnLoad = false;

  addSummarySheet(workbook, exportData);
  for (const [sheetName, datasetKey] of DATA_SHEETS) {
    addFlatSheet(workbook, sheetName, exportData.datasets[datasetKey] || []);
  }
  addDataDictionarySheet(workbook);
  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.from(raw);
}

export async function buildAuditPackage({ exportData, workbookBuffer, workbookName }) {
  const zip = new JSZip();
  const entries = new Map();
  const variantReconciliation = variantCountDistribution(exportData.datasets.tests);
  entries.set(workbookName, workbookBuffer);
  entries.set("audit/source_records.ndjson", ndjson(exportData.datasets.sourceRecords));
  entries.set("audit/finish_signals.ndjson", ndjson(exportData.datasets.finishSignals));
  entries.set("audit/scan_history.ndjson", ndjson(exportData.datasets.scanHistory));
  entries.set("audit/id_history.ndjson", ndjson(exportData.datasets.idHistory));
  entries.set("audit/identity_aliases.ndjson", ndjson(exportData.datasets.aliases));

  const manifest = {
    packageVersion: "1.0",
    exportSchemaVersion: HISTORY_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: exportData.identity.generatedAtUtc,
    generatedBy: exportData.identity.generatedBy,
    authorizationScope: exportData.identity.authorizationScope,
    request: {
      rows: exportData.identity.rows,
      contents: exportData.identity.contents,
      includeReviewerNotes: exportData.identity.includeReviewerNotes,
      filters: exportData.identity.filters,
      requestHash: exportData.identity.requestHash
    },
    grains: {
      tests: "one row per persisted logical test_id",
      variants: "one row per A/B/C slot evidenced by content, preview, or numeric share",
      actions: "one row per reviewer action, including undone actions",
      videoContext: "one row per video_id",
      sourceRecords: "one row per raw test_run_id"
    },
    counts: {
      logicalTests: exportData.datasets.tests.length,
      sourceRecords: exportData.datasets.sourceRecords.length,
      variants: exportData.datasets.variants.length,
      actions: exportData.datasets.actions.length,
      finishSignals: exportData.datasets.finishSignals.length,
      videos: exportData.datasets.videoContext.length
    },
    variantReconciliation: {
      testCountByExportedVariantRows: variantReconciliation,
      totalVariantRows: exportData.datasets.variants.length,
      rule:
        "Variant rows are emitted for A/B/C slots with configured content, a thumbnail preview, or a numeric watch-time share."
    },
    semantics: {
      resultEnum: [
        "winner",
        "performed_same",
        "inconclusive",
        "cancelled",
        "running",
        "unknown"
      ],
      highestShareVariant:
        "Descriptive only. It is never treated as a YouTube winner.",
      formulaSafety:
        "All workbook text is stored as string cells and audit records use JSON Lines. No active formulas are generated.",
      reproducibility:
        "The request hash identifies normalized filters and options. The export also records data checksums because source data may change between runs."
    },
    coverage: {
      strictEligibleN: exportData.coverage.population.strictEligibleN,
      widerEligibleN: exportData.coverage.population.widerEligibleN,
      widerThresholdDays: exportData.coverage.widerThresholdDays,
      widerThresholdRule: exportData.coverage.widerThresholdRule,
      addedStartedWithoutFinishEvidence: exportData.coverage.overThreeWeeksCount
    }
  };
  entries.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = Array.from(entries, ([name, content]) =>
    `${sha256(content)}  ${name}`
  ).join("\n");
  entries.set("checksums.sha256", `${checksums}\n`);
  for (const [name, content] of entries) zip.file(name, content);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}

function addSummarySheet(workbook, exportData) {
  const sheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { key: "metric", width: 38 },
    { key: "value", width: 26 },
    { key: "eligible", width: 14 },
    { key: "included", width: 14 },
    { key: "coverage", width: 14 },
    { key: "quality", width: 16 },
    { key: "denominator", width: 34 }
  ];
  const rows = [];
  section(rows, "EXPORT IDENTITY");
  detail(rows, "Schema version", exportData.identity.exportSchemaVersion);
  detail(rows, "Generated at UTC", exportData.identity.generatedAtUtc);
  detail(rows, "Generated by", exportData.identity.generatedBy);
  detail(rows, "Request hash", exportData.identity.requestHash);
  detail(rows, "Authorization scope", exportData.identity.authorizationScope);
  detail(
    rows,
    "Selected logical tests",
    exportData.coverage.population.selectedLogicalTests
  );
  detail(
    rows,
    "Sheet-backed logical tests",
    exportData.coverage.population.sheetBackedLogicalTests
  );
  detail(
    rows,
    "App-managed logical tests",
    exportData.coverage.population.appManagedLogicalTests
  );

  section(rows, "SCOPE");
  detail(rows, "Rows", label(exportData.identity.rows));
  detail(rows, "Contents", label(exportData.identity.contents));
  detail(rows, "Channel", exportData.identity.filters.channel);
  detail(rows, "Test type", exportData.identity.filters.testType);
  detail(rows, "Outcome action", exportData.identity.filters.action);
  detail(rows, "Search", exportData.identity.filters.search || "None");
  detail(
    rows,
    "Reviewer notes",
    exportData.identity.includeReviewerNotes ? "Included" : "Excluded"
  );

  section(rows, "LIMITATIONS");
  detail(rows, "Performance inputs", "No impressions or CTR are available.");
  detail(
    rows,
    "Inconclusive causes",
    `Reason coverage is ${formatRate(exportData.coverage.inconclusiveReason.coverageRate)}. Similar performance and insufficient traffic are separate only when explicit evidence exists.`
  );
  detail(
    rows,
    "Watch-time shares",
    "Shares are manually entered. Coverage varies by channel and period."
  );
  detail(
    rows,
    "Strict share analysis",
    "Strict share aggregates include title tests with complete configured variants and a 1.00 +/- 0.01 total. Thumbnail shares remain exported but unvalidated for aggregate conclusions."
  );
  const variantReconciliation = variantCountDistribution(exportData.datasets.tests);
  detail(
    rows,
    "Variant reconciliation",
    `${variantReconciliation["0"]} tests have no exportable variant evidence; ${variantReconciliation["1"]} have one variant; ${variantReconciliation["2"]} have two; ${variantReconciliation["3"]} have three; ${variantReconciliation.other} have more than three. Tests.exported_variant_count reconciles each test to Variants.`
  );
  detail(
    rows,
    "Coverage denominators",
    `Strict uses ${exportData.coverage.population.strictEligibleN} sheet-backed tests with terminal evidence. Wider uses ${exportData.coverage.population.widerEligibleN}, adding ${exportData.coverage.overThreeWeeksCount} tests whose stored start date is at least ${HISTORY_EXPORT_WIDER_THRESHOLD_DAYS} days old and whose finish was not captured. This is a reporting definition, not a measured finish event, and it never changes lifecycle status.`
  );
  detail(
    rows,
    "Wider threshold rule",
    `Include missing-finish tests when stored_start_age_days >= ${HISTORY_EXPORT_WIDER_THRESHOLD_DAYS}.`
  );
  const invalidDates = exportData.datasets.dataQuality.filter((row) =>
    String(row.issue_codes || "").includes("date_before_youtube")
  ).length;
  if (invalidDates) {
    detail(
      rows,
      "Stored date quality",
      `${invalidDates} tests contain a date from before YouTube existed. The source values remain visible for audit, but date spans and duration calculations exclude them.`
    );
  }
  detail(
    rows,
    "Authoritative winners",
    `${exportData.coverage.authoritativeWinnerCount} tests carry an explicit YouTube Winner result.`
  );
  detail(
    rows,
    "Video context",
    "YouTube Data API fields reflect current state at context_fetched_at_utc, not necessarily state when the test ran."
  );
  if (exportData.coverage.bias.material) {
    detail(
      rows,
      "Selection bias",
      "Share-bearing and non-share-bearing result distributions differ materially in at least one channel. Treat cross-channel comparisons cautiously."
    );
  }

  section(rows, "WARNINGS");
  if (!exportData.preview.warnings.length) {
    detail(rows, "Status", "No export warnings.");
  } else {
    for (const warning of exportData.preview.warnings) {
      rows.push(summaryRow({
        metric: warning.level.toUpperCase(),
        value: warning.message,
        quality: warning.level
      }));
    }
  }

  section(rows, "COVERAGE");
  for (const metric of [...exportData.coverage.strict, ...exportData.coverage.wider]) {
    aggregate(rows, metric);
  }
  aggregate(rows, exportData.coverage.inconclusiveReason);

  section(rows, "KPIS");
  aggregate(rows, {
    label: "Logical tests",
    value: exportData.datasets.tests.length,
    eligibleN: exportData.datasets.tests.length,
    includedN: exportData.datasets.tests.length,
    coverageRate: exportData.datasets.tests.length ? 1 : null,
    band: exportData.datasets.tests.length ? "good" : "unknown",
    denominatorType: "selected_scope"
  });
  aggregate(rows, {
    label: "Raw source records",
    value: exportData.datasets.sourceRecords.length,
    eligibleN: exportData.datasets.sourceRecords.length,
    includedN: exportData.datasets.sourceRecords.length,
    coverageRate: exportData.datasets.sourceRecords.length ? 1 : null,
    band: exportData.datasets.sourceRecords.length ? "good" : "unknown",
    denominatorType: "selected_scope"
  });
  aggregate(rows, {
    label: "Reviewer actions",
    value: exportData.datasets.actions.length,
    eligibleN: exportData.datasets.tests.length,
    includedN: new Set(exportData.datasets.actions.map((item) => item.test_id)).size,
    coverageRate: exportData.datasets.tests.length
      ? new Set(exportData.datasets.actions.map((item) => item.test_id)).size /
        exportData.datasets.tests.length
      : null,
    band: exportData.datasets.tests.length
      ? coverageBandLocal(
        new Set(exportData.datasets.actions.map((item) => item.test_id)).size /
        exportData.datasets.tests.length
      )
      : "unknown",
    denominatorType: "selected_logical_tests"
  });

  section(rows, "RESULT DISTRIBUTION");
  for (const result of [
    "winner",
    "performed_same",
    "inconclusive",
    "cancelled",
    "running",
    "unknown"
  ]) {
    const count = exportData.coverage.resultDistribution[result] || 0;
    aggregate(rows, {
      label: label(result),
      value: count,
      eligibleN: exportData.datasets.tests.length,
      includedN: count,
      coverageRate: exportData.datasets.tests.length
        ? count / exportData.datasets.tests.length
        : null,
      band: "distribution",
      denominatorType: "selected_logical_tests"
    });
  }

  section(rows, "COVERAGE BY CHANNEL");
  for (const channel of exportData.coverage.channel) {
    rows.push(summaryRow({
      metric: channel.dimension,
      value: channel.strictSharesN,
      eligible: channel.eligibleN,
      included: channel.strictSharesN,
      coverage: channel.strictSharesRate,
      quality: channel.strictSharesBand,
      denominator: "terminal_plus_over_three_weeks"
    }));
  }

  sheet.addRows(rows);
  styleSummary(sheet);
  sheet.autoFilter = { from: "A1", to: "G1" };
}

function addFlatSheet(workbook, name, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  const headers = orderedHeaders(rows, fallbackHeaders(name));
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: columnWidth(header, rows)
  }));
  if (rows.length) sheet.addRows(rows.map(sanitizeRow));
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: headers.length }
  };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
  applyNumberFormats(sheet, headers);
}

function addDataDictionarySheet(workbook) {
  const rows = dataDictionaryRows();
  addFlatSheet(workbook, "Data Dictionary", rows);
}

function styleSummary(sheet) {
  const dark = "151B21";
  const surface = "EEF2F5";
  const border = "CBD5DF";
  const accent = "F23D5A";
  sheet.getRow(1).values = [
    "Metric",
    "Value",
    "Eligible N",
    "Included N",
    "Coverage %",
    "Quality",
    "Denominator"
  ];
  sheet.getRow(1).height = 26;
  for (const cell of sheet.getRow(1).eachCell ? rowCells(sheet.getRow(1)) : []) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: dark } };
    cell.font = { bold: true, color: { argb: "FFFFFF" } };
    cell.alignment = { vertical: "middle" };
  }
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const first = sheet.getCell(row, 1);
    const value = String(first.value || "");
    if (/^[A-Z][A-Z ]+$/.test(value)) {
      sheet.getRow(row).height = 23;
      for (const cell of rowCells(sheet.getRow(row))) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: surface } };
        cell.font = { bold: true, color: { argb: dark } };
        cell.border = { bottom: { style: "thin", color: { argb: border } } };
      }
      first.font = { bold: true, color: { argb: accent } };
    }
    const quality = String(sheet.getCell(row, 6).value || "");
    const qualityCell = sheet.getCell(row, 6);
    if (quality === "low" || quality === "blocking") {
      qualityCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FDE8E8" } };
      qualityCell.font = { bold: true, color: { argb: "B42318" } };
    } else if (quality === "partial" || quality === "degrading") {
      qualityCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4D6" } };
      qualityCell.font = { bold: true, color: { argb: "9A6700" } };
    } else if (quality === "good") {
      qualityCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "E6F7ED" } };
      qualityCell.font = { bold: true, color: { argb: "16794B" } };
    }
  }
  sheet.getColumn(5).numFmt = "0.0%";
  sheet.getColumn(2).alignment = { wrapText: true, vertical: "top" };
}

function applyNumberFormats(sheet, headers) {
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const column = sheet.getColumn(index + 1);
    if (header === "watch_time_share" || header.endsWith("_rate")) {
      column.numFmt = "0.0%";
    } else if (
      header.endsWith("_hours") ||
      header.endsWith("_days") ||
      header === "share_sum"
    ) {
      column.numFmt = "0.00";
    } else if (
      header.endsWith("_count") ||
      header.endsWith("_seconds") ||
      header.endsWith("_number") ||
      header === "row_number"
    ) {
      column.numFmt = "#,##0";
    }
  }
}

function dataDictionaryRows() {
  return [
    dictionary("Tests", "test_id", "text", "Persisted surrogate identity for one logical test.", "", "Primary key"),
    dictionary("Tests", "video_id", "text", "YouTube video ID. A video may have multiple test_id values.", "", "Joins to Video Context"),
    dictionary("Tests", "result", "enum", "Canonical YouTube/app result. Never inferred from largest share.", "winner|performed_same|inconclusive|cancelled|running|unknown"),
    dictionary("Tests", "result_evidence", "enum", "Evidence supporting result.", "studio_explicit|sheet_explicit|inferred_legacy|unknown"),
    dictionary("Tests", "explicit_winner_variant", "enum", "A/B/C only when explicit Winner evidence identifies a variant.", "A|B|C|blank"),
    dictionary("Tests", "highest_share_variant", "enum", "Largest numeric share; descriptive only, never a YouTube result.", "A|B|C|blank"),
    dictionary("Tests", "operational_decision", "text", "Latest active reviewer decision. It does not redefine the YouTube result."),
    dictionary("Tests", "start_date_quality", "enum", "Quality of the stored start date. Pre-YouTube dates remain visible but are excluded from duration and date-span claims.", "source_date|invalid_pre_youtube|missing"),
    dictionary("Tests", "finish_date_quality", "enum", "Quality of the stored finish date. Pre-YouTube dates remain visible but are excluded from duration and date-span claims.", "source_date|invalid_pre_youtube|missing"),
    dictionary("Tests", "configured_variant_count", "number", "A/B/C slots with stored title, option, or thumbnail content."),
    dictionary("Tests", "exported_variant_count", "number", "Number of rows this test contributes to Variants. Includes share-evidenced slots whose title or image is missing.", "", "Must equal Variants rows for test_id"),
    dictionary("Tests", "variant_data_quality", "enum", "Completeness of the exported variant set and its stored content.", "missing|incomplete|content_missing|complete"),
    dictionary("Tests", "share_sum_valid", "boolean", "True only when every exported variant slot has a numeric share and total is 1.00 +/- 0.01."),
    dictionary("Tests", "test_duration_hours", "number", "Estimated or exact test duration in hours. Blank when unavailable."),
    dictionary("Tests", "test_duration_quality", "text", "Evidence quality for test_duration_hours."),
    dictionary("Tests", "detection_delay_hours", "number", "Hours from explicit finish occurrence to app observation. Blank when unavailable."),
    dictionary("Tests", "review_response_hours", "number", "Hours from finish evidence to first active reviewer action. Blank when unavailable."),
    dictionary("Tests", "total_cycle_hours", "number", "Hours from sheet start date to first active reviewer action, with uncertainty bounds."),
    dictionary("Tests", "days_open", "number", "Calendar days open as of days_open_as_of_utc. Never used to infer lifecycle."),
    dictionary("Variants", "test_id", "text", "Logical test foreign key.", "", "Joins to Tests"),
    dictionary("Variants", "variant_slot", "enum", "A/B/C slot supported by content, preview, or numeric share evidence.", "A|B|C"),
    dictionary("Variants", "variant_content_present", "boolean", "True when the slot has stored title, option, or thumbnail content; false for share-only evidence."),
    dictionary("Variants", "variant_evidence", "text", "Evidence that caused the slot to be exported.", "configured_option|thumbnail_preview|watch_time_share, joined with +"),
    dictionary("Variants", "watch_time_share", "number", "Canonical 0-1 watch-time share. Blank when unavailable."),
    dictionary("Variants", "is_youtube_winner", "boolean", "True only for explicit Winner evidence and matching slot."),
    dictionary("Actions", "test_id", "text", "Logical test foreign key.", "", "Joins to Tests"),
    dictionary("Actions", "active_for_analysis", "boolean", "False for undone actions, which remain for audit."),
    dictionary("Video Context", "video_id", "text", "One-row-per-video primary key.", "", "Joins from Tests.video_id"),
    dictionary("Video Context", "context_fetched_at_utc", "timestamp", "When current YouTube Data API state was fetched."),
    dictionary("Data Quality", "configured_variant_count", "number", "Stored variant-content count for this test."),
    dictionary("Data Quality", "exported_variant_count", "number", "Actual number of Variants rows for this test."),
    dictionary("Data Quality", "variant_data_quality", "enum", "Variant reconciliation status.", "missing|incomplete|content_missing|complete"),
    dictionary("Data Quality", "variant_content_missing_count", "number", "Variant rows supported only by shares and missing stored title/image content."),
    dictionary("Data Quality", "issue_codes", "text", "Semicolon-delimited reproducible quality flags. Variant codes include missing_variant_rows, incomplete_variant_set, and variant_content_missing."),
    dictionary("Summary", "quality", "enum", "Computed coverage band: low below 40%, partial from 40% through 60%, good above 60%.", "low|partial|good|unknown"),
    dictionary("Summary", "denominator", "text", "Explicit population used for the aggregate; never hardcoded.")
  ];
}

function dictionary(sheet, column, type, description, allowed = "", join = "") {
  return {
    sheet,
    column,
    type,
    description,
    allowed_values: allowed,
    join_or_grain: join
  };
}

function summaryRow({
  metric = "",
  value = "",
  eligible = "",
  included = "",
  coverage = "",
  quality = "",
  denominator = ""
}) {
  return { metric, value, eligible, included, coverage, quality, denominator };
}

function section(rows, title) {
  rows.push(summaryRow({ metric: title }));
}

function detail(rows, metric, value) {
  rows.push(summaryRow({ metric, value }));
}

function aggregate(rows, item) {
  rows.push(summaryRow({
    metric: item.label,
    value: item.value,
    eligible: item.eligibleN,
    included: item.includedN,
    coverage: item.coverageRate,
    quality: item.band,
    denominator: item.denominatorType || ""
  }));
}

function sanitizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" ? safeSpreadsheetText(value) : value
    ])
  );
}

function orderedHeaders(rows, fallback) {
  const headers = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  }
  return headers.length ? headers : fallback;
}

function fallbackHeaders(name) {
  return {
    Tests: ["test_id"],
    Variants: ["test_id", "variant_slot"],
    Actions: ["action_id", "test_id"],
    "Video Context": ["video_id"],
    "Data Quality": ["test_id", "issue_codes"],
    "Data Dictionary": ["sheet", "column", "type", "description", "allowed_values", "join_or_grain"]
  }[name] || ["id"];
}

function columnWidth(header, rows) {
  const sample = rows.slice(0, 100).map((row) => String(row[header] ?? "").length);
  const longest = Math.max(header.length, ...sample, 8);
  if (/json|reason|title|text|description|issue|note/i.test(header)) {
    return Math.min(48, Math.max(18, longest + 2));
  }
  return Math.min(28, Math.max(12, longest + 2));
}

function rowCells(row) {
  const cells = [];
  row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell));
  return cells;
}

function ndjson(rows) {
  return `${(rows || []).map((row) => JSON.stringify(row)).join("\n")}${rows?.length ? "\n" : ""}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "not available";
}

function label(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function coverageBandLocal(rate) {
  if (!Number.isFinite(rate)) return "unknown";
  if (rate < 0.4) return "low";
  if (rate <= 0.6) return "partial";
  return "good";
}

function variantCountDistribution(tests = []) {
  const distribution = { "0": 0, "1": 0, "2": 0, "3": 0, other: 0 };
  for (const test of tests) {
    const count = Number(test.exported_variant_count || 0);
    const key = count >= 0 && count <= 3 ? String(count) : "other";
    distribution[key] += 1;
  }
  return distribution;
}
