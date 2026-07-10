import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLinkedSpreadsheetIds,
  extractPublicSheetTitles,
  parsePublicCsvValues
} from "../lib/sheets.js";

test("extracts and decodes public Google Sheet tab captions", () => {
  const html = [
    '<div class="goog-inline-block docs-sheet-tab-caption">Jotform - A/B</div>',
    '<div class="goog-inline-block docs-sheet-tab-caption">Apps &amp; Sign</div>',
    '<div class="goog-inline-block docs-sheet-tab-caption">Apps &amp; Sign</div>'
  ].join("");
  assert.deepEqual(extractPublicSheetTitles(html), ["Jotform - A/B", "Apps & Sign"]);
});

test("extracts linked workbook IDs from reference tabs", () => {
  const values = [[
    "URL: https://docs.google.com/spreadsheets/d/1Rxfbiv_0o2cCwjTPXwHRu5Q2e3kKcVm21ClPFPeDLMY/edit?gid=1"
  ]];
  assert.deepEqual(extractLinkedSpreadsheetIds(values), ["1Rxfbiv_0o2cCwjTPXwHRu5Q2e3kKcVm21ClPFPeDLMY"]);
});

test("parses quoted public CSV values without breaking commas", async () => {
  const values = await parsePublicCsvValues('"Title","Notes"\n"A/B test","two, values"');
  assert.deepEqual(values, [["Title", "Notes"], ["A/B test", "two, values"]]);
});
