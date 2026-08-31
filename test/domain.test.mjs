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
  assert.deepEqual(parseDate("July 23", "2026-07-28"), { date: "2026-07-23", present: true });
  assert.deepEqual(parseDate("December 15", "2026-01-10"), { date: "2025-12-15", present: true });
  assert.deepEqual(parseDate(""), { date: "", present: false });
});

test("parses Date objects as local calendar dates without UTC drift", () => {
  assert.deepEqual(parseDate(new Date(2026, 6, 10)), {
    date: "2026-07-10",
    present: true
  });
});

test("keeps highest numeric share descriptive and preserves explicit no-clear result", () => {
  const shares = inferWinner({ A: 0.45, B: 0.55 }, { A: "Title A", B: "Title B" });
  assert.equal(shares.suggestedWinner, "");
  assert.equal(shares.result, "unknown");
  assert.equal(shares.highestShareVariant, "B");
  assert.match(shares.winnerReason, /not a YouTube result/i);
  const noClear = inferWinner({ A: "no_clear_winner", B: null });
  assert.equal(noClear.detectedOutcome, "no_clear");
  assert.equal(noClear.resultEntered, true);
});

test("accepts an explicit sheet winner without deriving it from shares", () => {
  const winner = inferWinner(
    { A: "Winner", B: null },
    { A: "Original", B: "Alternative" }
  );
  assert.equal(winner.result, "winner");
  assert.equal(winner.resultEvidence, "sheet_explicit");
  assert.equal(winner.explicitWinnerVariant, "A");
  assert.equal(winner.suggestedWinner, "A");
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
  assert.equal(records[0].suggestedWinner, "");
  assert.equal(records[0].result, "unknown");
  assert.equal(records[0].highestShareVariant, "B");
});

test("completed mixed-tab thumbnail rows close even when shares are descriptive", () => {
  const records = parseSheetRecords({
    spreadsheetId: "thumbnail-sheet",
    sourceKind: "thumbnail",
    sheetName: "With Podo",
    today: "2026-08-31",
    values: [
      [
        "Test Start / Published Date",
        "Test Finish Date",
        "Test Duration",
        "Video URL",
        "Video Title",
        "Thumbnail A",
        "Thumbnail B",
        "Thumbnail C",
        "A - Character Count",
        "B - Character Count",
        "C - Character Count",
        "A - Watch-Time Share",
        "B - Watch-Time Share",
        "C - Watch-Time Share",
        "Done"
      ],
      [
        "August 13",
        "August 21",
        "8",
        "https://youtu.be/lupM4P-fs_I",
        "How to Create Forms From Websites in Claude",
        "",
        "",
        "",
        "",
        "",
        "",
        "59.20%",
        "40.80%",
        "",
        "TRUE"
      ]
    ]
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].finishDate, "2026-08-21");
  assert.equal(records[0].status, "sheet_marked_done");
  assert.equal(records[0].watchTimeShare.A, 0.5920000000000001);
  assert.equal(records[0].watchTimeShare.B, 0.408);
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

test("blank finish date does not create a guessed finished signal", () => {
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
  assert.equal(records[0].effectiveFinishDate, "");
  assert.equal(records[0].status, "running");
});

test("future test rows stay scheduled instead of entering the active queue", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "AI Agents Podcast",
    today: "2026-08-04",
    values: [
      [
        "Published Date/ Test Start Date",
        "Video URL",
        "Title A",
        "Title B",
        "Done"
      ],
      [
        "2026-08-13",
        "https://youtu.be/abc123XYZ89",
        "Scheduled title A",
        "Scheduled title B",
        "False"
      ]
    ]
  });
  assert.equal(records[0].status, "scheduled");
});

test("explicit finish date marks tests as needing review", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "thumbnail",
    sheetName: "Jotform",
    today: "2026-06-22",
    values: [
      [
        "Test Start / Published Date",
        "Test Finish Date",
        "Video URL",
        "Video Title",
        "Thumbnail A",
        "Thumbnail B",
        "A - Watch-Time Share",
        "B - Watch-Time Share",
        "Done"
      ],
      [
        "2026-06-01",
        "2026-06-15",
        "https://youtu.be/abc123XYZ89",
        "Video",
        "",
        "",
        "",
        "",
        "False"
      ]
    ]
  });
  assert.equal(records[0].effectiveFinishDate, "2026-06-15");
  assert.equal(records[0].status, "needs_review");
});

test("parses thumbnail tabs when headers are not on the first row", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "thumbnail",
    sheetName: "Jotform New Thumbnail Tab",
    today: "2026-07-02",
    values: [
      ["Internal notes"],
      ["Owner", "BG"],
      [
        "Start Date",
        "End Date",
        "Video Link",
        "Title",
        "A Thumbnail",
        "B Thumbnail",
        "A Result",
        "B Result"
      ],
      [
        "2026-07-01",
        "",
        "https://www.youtube.com/watch?v=abc123XYZ89",
        "New thumbnail test",
        "A image",
        "B image",
        "",
        ""
      ]
    ]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].rowNumber, 4);
  assert.equal(records[0].testType, "thumbnail");
  assert.equal(records[0].videoId, "abc123XYZ89");
  assert.deepEqual(records[0].options, { A: "A image", B: "B image" });
});

test("skips report and note rows that are not actual A/B test runs", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "Published Videos With Ads",
    today: "2026-07-10",
    values: [
      ["Test Start Date", "Video URL", "Title A", "Title B", "Done"],
      ["", "A/B Test Result View Metrics", "", "", ""],
      ["2026-07-01", "https://youtu.be/abc123XYZ_9", "Original", "Alternative", ""]
    ]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].videoId, "abc123XYZ_9");
});

test("keeps historical test rows with lifecycle data and two options even when the old URL cell lost its link", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "Historical Tests",
    today: "2026-07-10",
    values: [
      ["Test Start Date", "Video URL", "Title A", "Title B", "Done"],
      ["2025-10-22", "Old video title", "Original", "Alternative", "true"]
    ]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "sheet_marked_done");
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
  assert.equal(canonicalChannelName("Jotform App Channel"), "Apps");
  assert.equal(canonicalChannelName("Jotform Sign Channel"), "Sign");
  assert.equal(canonicalChannelName("Jotform Boards Channel"), "Boards");
  assert.equal(canonicalChannelName("Jotform PDF Editor Channel"), "PDF Editor");
  assert.equal(canonicalChannelName("Workflow Channel"), "Workflow");
  assert.equal(canonicalChannelName("Jotform Workflows"), "Workflow");
  assert.equal(canonicalChannelName("With Podo"), "With Podo");
  assert.equal(canonicalChannelName("Noupe"), "Noupe");
  assert.deepEqual(
    ["Sign", "Other", "AI Agents", "Jotform", "Apps", "AI Agents Podcast", "Boards", "PDF Editor", "Workflow", "With Podo", "Noupe"].sort(compareChannels),
    ["Jotform", "AI Agents Podcast", "AI Agents", "Apps", "Sign", "Boards", "PDF Editor", "Workflow", "Noupe", "Other", "With Podo"]
  );
});
