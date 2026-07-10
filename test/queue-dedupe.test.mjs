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

test("collapses repeated app-managed Studio signals for the same video", () => {
  const result = dedupeQueueRuns([
    {
      ...base,
      testRunId: "app-old",
      sourceKind: "app_registry",
      spreadsheetId: "",
      sheetName: "App registry",
      rowNumber: 0,
      startDate: "",
      optionFingerprint: "",
      finishEventId: "event-old"
    },
    {
      ...base,
      testRunId: "app-new",
      sourceKind: "app_registry",
      spreadsheetId: "",
      sheetName: "App registry",
      rowNumber: 0,
      startDate: "",
      optionFingerprint: "",
      finishEventId: "event-new",
      finishEventAt: "2026-07-10T12:00:00Z"
    }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].duplicateCount, 1);
  assert.equal(result[0].possibleRetest, false);
});

test("app-managed signals do not make a sheet run look like a retest", () => {
  const result = dedupeQueueRuns([
    { ...base, testRunId: "sheet", sourceKind: "title", spreadsheetId: "main", sheetName: "Jotform", rowNumber: 4 },
    {
      ...base,
      testRunId: "app",
      sourceKind: "app_registry",
      spreadsheetId: "",
      sheetName: "App registry",
      rowNumber: 0,
      startDate: "",
      optionFingerprint: ""
    }
  ]);
  assert.equal(result.find((run) => run.testRunId === "sheet").possibleRetest, false);
  assert.equal(result.find((run) => run.testRunId === "app").possibleRetest, false);
});

test("merges a title-only app signal after YouTube later resolves its video ID", () => {
  const result = dedupeQueueRuns([
    {
      ...base,
      testRunId: "title-only",
      videoId: "",
      videoTitle: "Introducing Jotform AI App Builder",
      channel: "Jotform",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    },
    {
      ...base,
      testRunId: "resolved",
      videoId: "resolved-video",
      videoTitle: "Introducing Jotform AI App Builder",
      channel: "Jotform",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].videoId, "resolved-video");
  assert.equal(result[0].possibleRetest, false);
});

test("merges app signals when current YouTube metadata improves the stored title", () => {
  const result = dedupeQueueRuns([
    {
      ...base,
      testRunId: "resolved",
      videoId: "resolved-video",
      videoTitle: "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder",
      currentYoutubeTitle: "June 2026 | Announcing Jotform AI App Builder",
      channel: "Jotform",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    },
    {
      ...base,
      testRunId: "legacy-title",
      videoId: "",
      videoTitle: "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder",
      currentYoutubeTitle: "",
      channel: "Unknown source",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].possibleRetest, false);
});

test("does not let a stale hidden channel ID prevent an exact unknown-source merge", () => {
  const title = "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder";
  const result = dedupeQueueRuns([
    {
      ...base,
      testRunId: "resolved",
      videoId: "resolved-video",
      videoTitle: title,
      currentYoutubeTitle: title,
      channel: "Jotform",
      youtubeChannelId: "actual-channel",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    },
    {
      ...base,
      testRunId: "unknown",
      videoId: "",
      videoTitle: title,
      currentYoutubeTitle: title,
      channel: "Unknown source",
      youtubeChannelId: "stale-watcher-id",
      sourceKind: "app_registry",
      startDate: "",
      optionFingerprint: ""
    }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].videoId, "resolved-video");
});
