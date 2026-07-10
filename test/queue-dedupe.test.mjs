import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeQueueRuns } from "../lib/queue-dedupe.mjs";

const base = {
  videoId: "video-1",
  testType: "title",
  startDate: "2026-07-01",
  optionFingerprint: "options-1",
  queueStatus: "confirmed_finished",
  options: { A: "One", B: "Two" },
  troubles: []
};

test("collapses the same logical run copied across workbook sources", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "main", spreadsheetId: "main-book", sheetName: "AI Agents", rowNumber: 4 },
    { ...base, testRunId: "linked", spreadsheetId: "linked-book", sheetName: "AI Agents", rowNumber: 9 }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].duplicateCount, 1);
  assert.equal(result[0].duplicateSources.length, 2);
  assert.equal(result[0].possibleRetest, false);
});

test("preserves real retests when date or options change", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "first", spreadsheetId: "main", sheetName: "Jotform", rowNumber: 4 },
    { ...base, testRunId: "later", spreadsheetId: "main", sheetName: "Jotform", rowNumber: 14, startDate: "2026-07-08" },
    { ...base, testRunId: "new-options", spreadsheetId: "linked", sheetName: "Jotform", rowNumber: 20, optionFingerprint: "options-2" }
  ]);
  assert.equal(result.length, 3);
  assert.equal(result.every((run) => run.possibleRetest), true);
});

test("does not collapse separate rows from the same source tab", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "row-4", spreadsheetId: "main", sheetName: "Jotform", rowNumber: 4 },
    { ...base, testRunId: "row-5", spreadsheetId: "main", sheetName: "Jotform", rowNumber: 5 }
  ]);
  assert.equal(result.length, 2);
});

test("collapses stale IDs for the exact same source row", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "old-id", spreadsheetId: "main", sheetName: "Apps", rowNumber: 56 },
    { ...base, testRunId: "current-id", spreadsheetId: "main", sheetName: "Apps", rowNumber: 56, finishEventId: "event-1" }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].testRunId, "current-id");
  assert.equal(result[0].duplicateCount, 1);
});

test("keeps the most actionable duplicate as the visible card", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "watching", spreadsheetId: "main", sheetName: "Apps", rowNumber: 4, queueStatus: "watching" },
    { ...base, testRunId: "confirmed", spreadsheetId: "linked", sheetName: "Apps", rowNumber: 7, finishEventId: "event-1" }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].testRunId, "confirmed");
  assert.equal(result[0].finishEventId, "event-1");
});
