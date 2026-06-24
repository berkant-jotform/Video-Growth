import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAppliedChange,
  detectNotificationOutcome,
  matchFinishEventToRun,
  parseStudioNotification
} from "../lib/finish-events.mjs";
import { parseSheetRecords } from "../lib/domain.mjs";

test("parses Studio notification video IDs and no-clear outcome", () => {
  const event = parseStudioNotification({
    rawText: "Your Test & Compare result is ready. Not enough impressions to declare a winner.",
    url: "https://studio.youtube.com/video/abc123XYZ_9/edit",
    channel: "Jotform"
  });
  assert.equal(event.videoId, "abc123XYZ_9");
  assert.equal(event.detectedOutcome, "no_clear");
  assert.equal(event.channel, "Jotform");
});

test("detects winner option from notification text", () => {
  assert.equal(detectNotificationOutcome("Thumbnail test completed. Option B won."), "winner_b");
  assert.equal(detectNotificationOutcome("Title test finished. Winner: C"), "winner_c");
});

test("matches finish events by video ID first", () => {
  const activeRuns = [
    { testRunId: "one", videoId: "111111", channel: "Jotform", videoTitle: "Old title" },
    { testRunId: "two", videoId: "222222", channel: "AI Agents", videoTitle: "Agent title" }
  ];
  const match = matchFinishEventToRun({ videoId: "222222", channel: "Wrong channel", rawText: "" }, activeRuns);
  assert.equal(match.run.testRunId, "two");
  assert.equal(match.matchedConfidence, "video_id");
});

test("matches finish events by normalized title and channel when video ID is missing", () => {
  const activeRuns = [
    {
      testRunId: "run-title",
      videoId: "",
      channel: "AI Agents Podcast",
      videoTitle: "From Notes to Action: Fellow AI's Vision for Workflows"
    }
  ];
  const match = matchFinishEventToRun(
    {
      channel: "AI Agents Podcast",
      rawText: "Your title test finished for From Notes to Action Fellow AI s Vision for Workflows"
    },
    activeRuns
  );
  assert.equal(match.run.testRunId, "run-title");
  assert.equal(match.matchedConfidence, "title_channel");
});

test("blank finish date stays running instead of becoming a guessed finished item", () => {
  const records = parseSheetRecords({
    spreadsheetId: "sheet",
    sourceKind: "title",
    sheetName: "Jotform",
    today: "2026-06-24",
    values: [
      ["Published Date/ Test Start Date", "Test Finish Date", "Video URL", "Video Title", "Title A", "Title B"],
      ["2026-06-01", "", "https://youtu.be/abc123XYZ_9", "Video", "A title", "B title"]
    ]
  });
  assert.equal(records[0].status, "running");
  assert.equal(records[0].effectiveFinishDate, "");
});

test("B/C title metadata change creates applied-change event, but A does not", () => {
  const base = {
    testRunId: "run",
    videoId: "abc123",
    channel: "Jotform",
    testType: "title",
    status: "running",
    options: {
      A: "Original title",
      B: "Better title"
    },
    currentYoutubeTitle: "Better title"
  };
  const event = detectAppliedChange(base);
  assert.equal(event.detectedOutcome, "winner_b");
  assert.equal(event.source, "metadata");
  assert.equal(detectAppliedChange({ ...base, currentYoutubeTitle: "Original title" }), null);
});

test("A or no-clear without notification stays unconfirmed", () => {
  const event = detectAppliedChange({
    testRunId: "run",
    videoId: "abc123",
    channel: "Jotform",
    testType: "title",
    status: "running",
    options: {
      A: "Original title",
      B: "Better title"
    },
    currentYoutubeTitle: "Original title"
  });
  assert.equal(event, null);
});
