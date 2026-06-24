import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStatus,
  extractSpreadsheetId,
  extractVideoId,
  inferWinner,
  makeTestRunId,
  parseDate,
  parseSheetRecords
} from "../lib/domain.mjs";
import { canonicalChannelName, compareChannels } from "../lib/channels.mjs";

test("extracts YouTube video IDs from supported URLs", () => {
  assert.equal(extractVideoId("https://youtu.be/vTgIhkm1QJ0"), "vTgIhkm1QJ0");
  assert.equal(
    extractVideoId("https://www.youtube.com/watch?v=eqiZ-rMMgzU"),
    "eqiZ-rMMgzU"
  );
  assert.equal(
    extractVideoId("https://studio.youtube.com/video/8_bhdo_uF8E/edit"),
    "8_bhdo_uF8E"
  );
  assert.equal(extractVideoId("https://youtube.com/shorts/abc123XYZ89"), "abc123XYZ89");
});

test("extracts spreadsheet IDs from URLs or raw IDs", () => {
  assert.equal(
    extractSpreadsheetId("https://docs.google.com/spreadsheets/d/abc_123-DEF/edit"),
    "abc_123-DEF"
  );
  assert.equal(extractSpreadsheetId("abc_123-DEF"), "abc_123-DEF");
});

test("parses dates and falls back safely", () => {
  assert.deepEqual(parseDate("2026-06-15"), { date: "2026-06-15", present: true });
  assert.deepEqual(parseDate("06/15/2026"), { date: "2026-06-15", present: true });
  assert.deepEqual(parseDate(""), { date: "", present: false });
});

test("infers numeric winner and no-clear result", () => {
  assert.deepEqual(inferWinner({ A: 0.45, B: 0.55 }).suggestedWinner, "B");
  const noClear = inferWinner({ A: "no_clear_winner", B: null });
  assert.equal(noClear.detectedOutcome, "no_clear");
  assert.equal(noClear.resultEntered, true);
});

test("hybrid detection treats entered percentages as already logged", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "Jotform",
    today: "2026-06-22",
    values: [
      [
        "Published Date/ Test Start Date",
        "Test Finish Date",
        "Video URL",
        "Title A",
        "Title B",
        "A - Watch-Time Share",
        "B - Watch-Time Share",
        "Done"
      ],
      [
        "2026-06-01",
        "2026-06-15",
        "https://youtu.be/abc123XYZ89",
        "A",
        "B",
        "45%",
        "55%",
        "False"
      ]
    ]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "result_logged");
  assert.equal(records[0].suggestedWinner, "B");
});

test("hybrid detection treats not-enough-impressions text as already logged", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "Jotform",
    today: "2026-06-22",
    values: [
      [
        "Published Date/ Test Start Date",
        "Test Finish Date",
        "Video URL",
        "Title A",
        "Title B",
        "A - Watch-Time Share",
        "B - Watch-Time Share",
        "Done"
      ],
      [
        "2026-06-01",
        "2026-06-15",
        "https://youtu.be/abc123XYZ89",
        "A",
        "B",
        "Not enough impressions to declare a winner",
        "",
        "False"
      ]
    ]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "result_logged");
  assert.equal(records[0].detectedOutcome, "no_clear");
  assert.equal(records[0].suggestedWinner, "No clear winner");
});

test("date fallback marks finished tests as needing review", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "thumbnail",
    sheetName: "Jotform",
    today: "2026-06-22",
    values: [
      [
        "Test Start / Published Date",
        "Video URL",
        "Video Title",
        "Thumbnail A",
        "Thumbnail B",
        "A - Watch-Time Share",
        "B - Watch-Time Share",
        "Done"
      ],
      ["2026-06-01", "https://youtu.be/abc123XYZ89", "Video", "", "", "", "", "False"]
    ]
  });
  assert.equal(records[0].effectiveFinishDate, "2026-06-15");
  assert.equal(records[0].status, "needs_review");
});

test("test run ID changes when option fingerprint changes", () => {
  const base = {
    spreadsheetId: "sheet",
    sheetName: "Jotform",
    rowNumber: 2,
    testType: "title",
    videoId: "abc123XYZ89",
    startDate: "2026-06-01",
    finishDate: "2026-06-15"
  };
  assert.notEqual(
    makeTestRunId({ ...base, optionFingerprint: "one" }),
    makeTestRunId({ ...base, optionFingerprint: "two" })
  );
});

test("classification keeps missing data visible", () => {
  assert.equal(
    classifyStatus({
      done: false,
      troubles: [{ severity: "error" }],
      effectiveFinishDate: "2026-06-15",
      today: "2026-06-22",
      resultEntered: false,
      detectedOutcome: "result_missing"
    }),
    "missing_data"
  );
});

test("classification treats entered results as logged even when source data is messy", () => {
  assert.equal(
    classifyStatus({
      done: false,
      troubles: [{ severity: "error" }],
      effectiveFinishDate: "2026-06-15",
      today: "2026-06-22",
      resultEntered: true,
      detectedOutcome: "winner_b"
    }),
    "result_logged"
  );
});

test("canonicalizes channel names and applies priority order", () => {
  assert.equal(canonicalChannelName("AI Agents AB Test"), "AI Agents");
  assert.equal(canonicalChannelName("AI Agents Podcast thumbnails"), "AI Agents Podcast");
  assert.equal(canonicalChannelName("Jotform Apps Channel"), "Apps");
  assert.deepEqual(
    ["Sign", "Other", "AI Agents", "Jotform", "Apps", "AI Agents Podcast"].sort(compareChannels),
    ["Jotform", "AI Agents Podcast", "AI Agents", "Apps", "Other", "Sign"]
  );
});
