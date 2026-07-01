import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAppliedChange,
  detectNotificationOutcome,
  explainUnmatchedFinishEvent,
  extractFinishNotificationSnippets,
  isLikelyFinishNotification,
  matchFinishEventToRun,
  parseWatcherTabs,
  parseStudioNotification,
  suggestFinishEventMatches
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

test("extracts multiple current Studio A/B notifications from a bell panel", () => {
  const text = [
    "Notifications All Earn Analytics Ideas News Today",
    "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner 1 hour ago",
    "This week",
    "A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance 2 days ago",
    "A/B test inconclusive How to Share a PowerPoint or Google Slides Presentation in Zoom: The test completed with no winner 2 days ago"
  ].join(" ");
  const snippets = extractFinishNotificationSnippets(text);
  assert.deepEqual(snippets, [
    "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner",
    "A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance",
    "A/B test inconclusive How to Share a PowerPoint or Google Slides Presentation in Zoom: The test completed with no winner"
  ]);
});

test("detects winner option from notification text", () => {
  assert.equal(detectNotificationOutcome("Thumbnail test completed. Option B won."), "winner_b");
  assert.equal(detectNotificationOutcome("Title test finished. Winner: C"), "winner_c");
});

test("recognizes current YouTube Studio A/B notification wording", () => {
  assert.equal(
    isLikelyFinishNotification("A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner"),
    true
  );
  assert.equal(
    detectNotificationOutcome("A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner"),
    "finished_unknown"
  );
  assert.equal(
    isLikelyFinishNotification("A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance"),
    true
  );
  assert.equal(
    detectNotificationOutcome("A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance"),
    "no_clear"
  );
  assert.equal(
    isLikelyFinishNotification("A/B test inconclusive How to Share a PowerPoint or Google Slides Presentation in Zoom: The test completed with no winner"),
    true
  );
  assert.equal(
    detectNotificationOutcome("A/B test inconclusive How to Share a PowerPoint or Google Slides Presentation in Zoom: The test completed with no winner"),
    "no_clear"
  );
});

test("filters Studio edit-page noise from finish notifications", () => {
  assert.equal(
    isLikelyFinishNotification("Set a thumbnail that stands out and draws viewers' attention. Learn more"),
    false
  );
  assert.equal(
    isLikelyFinishNotification("Features like personalized ads and notifications won’t be available on videos made for kids."),
    false
  );
  assert.equal(
    isLikelyFinishNotification("Test & Compare results are ready for your thumbnail test."),
    true
  );
  assert.equal(
    isLikelyFinishNotification("Not enough impressions to declare a winner."),
    true
  );
  assert.equal(
    isLikelyFinishNotification("Introducing Jotform AI App Builder A/B Test running"),
    false
  );
  assert.equal(isLikelyFinishNotification("A/B Test completed"), false);
  assert.equal(isLikelyFinishNotification("Thumbnail test ready"), false);
  assert.equal(isLikelyFinishNotification("Thumbnail test ready Set test"), false);
  assert.equal(
    isLikelyFinishNotification("Test finished. Ran from February 26, 2026 at 4:16 PM to March 12, 2026 at 5:03 PM."),
    true
  );
});

test("parses watcher tabs from channel IDs and Studio URLs", () => {
  assert.deepEqual(
    parseWatcherTabs(
      [
        "Jotform | UC12345678901234567890",
        "AI Agents Podcast | https://studio.youtube.com/channel/UCabcdefabcdefabcdefab"
      ].join("\n")
    ),
    [
      {
        label: "Jotform",
        url: "https://studio.youtube.com/channel/UC12345678901234567890"
      },
      {
        label: "AI Agents Podcast",
        url: "https://studio.youtube.com/channel/UCabcdefabcdefabcdefab"
      }
    ]
  );
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

test("matches current Studio A/B notification wording by extracted video title", () => {
  const activeRuns = [
    {
      testRunId: "zoom-run",
      videoId: "zoom123",
      channel: "Jotform",
      videoTitle: "How to Configure Zoom Settings & AI Companion"
    }
  ];
  const event = parseStudioNotification({
    channel: "Jotform",
    rawText: "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(event.videoTitle, "How to Configure Zoom Settings & AI Companion");
  assert.equal(match.run.testRunId, "zoom-run");
  assert.equal(match.matchedConfidence, "title_channel");
});

test("matches exact notification titles across channel name variants", () => {
  const activeRuns = [
    {
      testRunId: "jotform-apps-run",
      videoId: "apps123",
      channel: "Jotform Apps",
      videoTitle: "Introducing Jotform AI App Builder"
    }
  ];
  const event = parseStudioNotification({
    channel: "Jotform",
    rawText: "A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run.testRunId, "jotform-apps-run");
  assert.equal(match.matchedConfidence, "title_channel_alias");
});

test("suggests possible sheet rows for unregistered finish signals", () => {
  const runs = [
    {
      testRunId: "candidate",
      videoId: "candidate123",
      channel: "Jotform Apps",
      testType: "title",
      sheetName: "Jotform Apps",
      rowNumber: 42,
      videoTitle: "Introducing Jotform AI App Builder",
      currentYoutubeTitle: "Introducing Jotform AI App Builder"
    }
  ];
  const event = parseStudioNotification({
    channel: "Jotform",
    rawText: "A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance"
  });
  const suggestions = suggestFinishEventMatches(event, runs);
  assert.equal(suggestions[0].testRunId, "candidate");
  assert.equal(suggestions[0].confidence, "high");
  assert.match(suggestions[0].reason, /related channel name|channel name differs/);
  assert.equal(explainUnmatchedFinishEvent(event, suggestions), "Possible sheet row found; review before accepting the match.");
});

test("matches close Studio notification titles by token overlap", () => {
  const activeRuns = [
    {
      testRunId: "workspace-agents",
      videoId: "agent123",
      channel: "AI Agents",
      videoTitle: "ChatGPT Workspace Agents Explained"
    }
  ];
  const event = parseStudioNotification({
    channel: "AI Agents",
    rawText: "A/B test performed well for all How ChatGPT Workspace Agents Work: Results with very similar performance"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run.testRunId, "workspace-agents");
  assert.equal(match.matchedConfidence, "fuzzy_title_channel");
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
