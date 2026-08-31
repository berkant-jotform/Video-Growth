import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLinkedSpreadsheetIds,
  extractPublicSheetTabs,
  extractPublicSheetTitles,
  normalizeSheetCellValue,
  parsePublicCsvValues,
  readWorkbookGraph
} from "../lib/sheets.js";

test("extracts and decodes public Google Sheet tab captions", () => {
  const html = [
    '<div class="goog-inline-block docs-sheet-tab-caption">Jotform - A/B</div>',
    '<div class="goog-inline-block docs-sheet-tab-caption">Apps &amp; Sign</div>',
    '<div class="goog-inline-block docs-sheet-tab-caption">Apps &amp; Sign</div>'
  ].join("");
  assert.deepEqual(extractPublicSheetTitles(html), ["Jotform - A/B", "Apps & Sign"]);
});

test("extracts more than forty public sheet tabs without truncation", () => {
  const html = Array.from({ length: 45 }, (_, index) =>
    `<div class="goog-inline-block docs-sheet-tab-caption">Tab ${index + 1}</div>`
  ).join("");
  const titles = extractPublicSheetTitles(html);
  assert.equal(titles.length, 45);
  assert.equal(titles[44], "Tab 45");
});

test("extracts stable public tab IDs when Google exposes gids", () => {
  const html = [
    '<div data-sheet-id="101"><div class="goog-inline-block docs-sheet-tab-caption">Current</div></div>',
    '<div data-sheet-id="202"><div class="goog-inline-block docs-sheet-tab-caption">Archive</div></div>'
  ].join("");
  assert.deepEqual(extractPublicSheetTabs(html), [
    { title: "Current", externalTabId: "101" },
    { title: "Archive", externalTabId: "202" }
  ]);
});

test("extracts linked workbook IDs from reference tabs", () => {
  const values = Array.from({ length: 20 }, () => []);
  values[18][24] = "URL: https://docs.google.com/spreadsheets/d/1Rxfbiv_0o2cCwjTPXwHRu5Q2e3kKcVm21ClPFPeDLMY/edit?gid=1";
  assert.deepEqual(extractLinkedSpreadsheetIds(values), ["1Rxfbiv_0o2cCwjTPXwHRu5Q2e3kKcVm21ClPFPeDLMY"]);
});

test("parses quoted public CSV values without breaking commas", async () => {
  const values = await parsePublicCsvValues('"Title","Notes"\n"A/B test","two, values"');
  assert.deepEqual(values, [["Title", "Notes"], ["A/B test", "two, values"]]);
});

test("normalizes supported spreadsheet cell objects without leaking object text", () => {
  assert.equal(normalizeSheetCellValue({ richText: [{ text: "No clear " }, { text: "winner" }] }), "No clear winner");
  assert.equal(normalizeSheetCellValue({ formula: "=A1", result: "42%" }), "42%");
  assert.equal(normalizeSheetCellValue({ error: "#N/A" }), "");
});

test("workbook graph follows nested links, avoids cycles, and isolates failures", async () => {
  const link = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
  const workbooks = {
    root_workbook_1234567890: [{ title: "Root", values: [[link("child_workbook_123456789")]] }],
    child_workbook_123456789: [{ title: "Child", values: [[link("root_workbook_1234567890"), link("missing_workbook_1234567")]] }]
  };
  const result = await readWorkbookGraph({
    spreadsheetId: "root_workbook_1234567890",
    readWorkbook: async (id) => {
      if (!workbooks[id]) throw new Error("blocked");
      return workbooks[id];
    }
  });
  assert.deepEqual(result.map((sheet) => sheet.title), ["Root", "Child"]);
  assert.equal(result.missingLinkedWorkbooks.length, 1);
  assert.equal(result.readIncomplete, true);
  assert.equal(result.workbookReports.length, 3);
});

test("workbook graph follows links discovered from formulas or hyperlinks", async () => {
  const root = [["No visible URL"]];
  root.linkedSpreadsheetIds = ["linked_workbook_123456789012345"];
  const linked = [["Video URL", "Title A", "Title B"], ["https://youtu.be/abc123XYZ_9", "A", "B"]];
  const graph = await readWorkbookGraph({
    spreadsheetId: "root_workbook_123456789012345",
    readWorkbook: async (spreadsheetId) => {
      const sheets = spreadsheetId.startsWith("root")
        ? [{ title: "Index", values: root }]
        : [{ title: "Tests", values: linked }];
      sheets.linkedSpreadsheetIds = spreadsheetId.startsWith("root") ? root.linkedSpreadsheetIds : [];
      return sheets;
    }
  });
  assert.deepEqual(graph.map((sheet) => sheet.spreadsheetId), [
    "root_workbook_123456789012345",
    "linked_workbook_123456789012345"
  ]);
  assert.equal(graph.workbookReports[1].parentSpreadsheetId, "root_workbook_123456789012345");
});
