import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAppliedChange,
  detectNotificationOutcome,
  consolidateUnmatchedFinishEvents,
  explainUnmatchedFinishEvent,
  expandConnectorEventInputs,
  extractAccessibleFinishEventsFromScan,
  extractFinishNotificationSnippets,
  isLikelyFinishNotification,
  matchFinishEventToRun,
  parseWatcherTabs,
  parseStudioNotification,
  resolveWatcherTabsFromRuns,
  suggestFinishEventMatches
} from "../lib/finish-events.mjs";
import { inspectWorkbookSheets, parseSheetRecords } from "../lib/domain.mjs";

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

test("keeps named watcher channels before their Studio IDs are configured", () => {
  const watchers = parseWatcherTabs([
    { label: "Jotform", target: "UCabcdefghijk" },
    { label: "Apps", target: "" }
  ]);
  assert.deepEqual(watchers, [
    { label: "Jotform", url: "https://studio.youtube.com/channel/UCabcdefghijk" },
    { label: "Apps", url: "" }
  ]);
  assert.deepEqual(parseWatcherTabs("Apps |\nSign | UCabcdefghijkl"), [
    { label: "Apps", url: "" },
    { label: "Sign", url: "https://studio.youtube.com/channel/UCabcdefghijkl" }
  ]);
});

test("deduplicates watcher URLs that point to the same Studio channel", () => {
  const watchers = parseWatcherTabs([
    { label: "Jotform", url: "https://studio.youtube.com/channel/UCh04CepWeaJT7wJUIgnmzJQ" },
    { label: "", url: "https://studio.youtube.com/channel/UCh04CepWeaJT7wJUIgnmzJQ/videos/upload?filter=all" }
  ]);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].label, "Jotform");
});

test("resolves a named watcher from scanned YouTube channel metadata", () => {
  const watchers = resolveWatcherTabsFromRuns(
    [{ label: "Apps", url: "" }, { label: "Jotform", url: "https://studio.youtube.com/channel/UCsavedchannel" }],
    [{ channel: "Jotform Apps", youtubeChannelId: "UCappsmetadata" }]
  );
  assert.deepEqual(watchers, [
    { label: "Apps", url: "https://studio.youtube.com/channel/UCappsmetadata", resolvedFrom: "youtube_metadata" },
    { label: "Jotform", url: "https://studio.youtube.com/channel/UCsavedchannel", resolvedFrom: "saved" }
  ]);
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

test("extracts current YouTube notification page A/B results", () => {
  const text = [
    "Notifications All Earn Analytics Ideas News Today",
    "A/B test performed well for all June 2026 | Announcing Jotform AI App Builder: Results with very similar performance 1 hour ago",
    "A/B test inconclusive How to Auto-Close Forms in ChatGPT: Not enough views to determine a winner 9 days ago",
    "Brand deals, your way: Learn from fellow creators on our new series 13 days ago"
  ].join(" ");
  const snippets = extractFinishNotificationSnippets(text);
  assert.deepEqual(snippets, [
    "A/B test performed well for all June 2026 | Announcing Jotform AI App Builder: Results with very similar performance",
    "A/B test inconclusive How to Auto-Close Forms in ChatGPT: Not enough views to determine a winner"
  ]);
});

test("extracts recent YouTube bell A/B notifications with exact age text", () => {
  const text = [
    "Notifications All Earn Analytics Ideas News Today",
    "A/B test performed well for all How to Preview your Form in Claude AI: Results with very similar performance 11 minutes ago",
    "A/B test performed well for all How to Optimize Forms with AI in ChatGPT: Results with very similar performance 15 hours ago",
    "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner 2 days ago",
    "A/B test inconclusive How to Create Forms from Spreadsheets in ChatGPT: The test completed with no winner 5 days ago"
  ].join(" ");
  const snippets = extractFinishNotificationSnippets(text);
  assert.deepEqual(new Set(snippets), new Set([
    "A/B test performed well for all How to Preview your Form in Claude AI: Results with very similar performance",
    "A/B test performed well for all How to Optimize Forms with AI in ChatGPT: Results with very similar performance",
    "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner",
    "A/B test inconclusive How to Create Forms from Spreadsheets in ChatGPT: The test completed with no winner"
  ]));
});

test("expands raw connector text blocks into app-parsed finish events", () => {
  const rawText = [
    "Notifications All Earn Policy Analytics Ideas News Today",
    "A/B test performed well for all How to Add Conditional Questions in Google Forms (Branching Logic Tutorial): Results with very similar performance 21 hours ago",
    "Video can't be monetized: Claimed content found in another video",
    "A/B test won How to Use Claude App to Create Conditional Logic: We updated your video to use the winner 3 days ago"
  ].join(" ");
  const events = expandConnectorEventInputs([
    {
      source: "visible_text_block",
      rawText,
      channel: "Jotform",
      channelId: "UC12345678901234567890"
    }
  ]);
  assert.deepEqual(new Set(events.map((event) => event.rawText)), new Set([
    "A/B test performed well for all How to Add Conditional Questions in Google Forms (Branching Logic Tutorial): Results with very similar performance",
    "A/B test won How to Use Claude App to Create Conditional Logic: We updated your video to use the winner"
  ]));
  const conditional = events.find((event) => event.rawText.includes("Conditional Questions"));
  const claude = events.find((event) => event.rawText.includes("Claude App"));
  assert.equal(conditional.videoTitle, "How to Add Conditional Questions in Google Forms (Branching Logic Tutorial)");
  assert.equal(conditional.notificationAge, "21 hours ago");
  assert.equal(claude.notificationAge, "3 days ago");
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
  assert.equal(
    isLikelyFinishNotification("A/B test inconclusive Excel Tutorial for Beginners: Not enough views to determine a winner"),
    true
  );
  assert.equal(
    detectNotificationOutcome("A/B test inconclusive Excel Tutorial for Beginners: Not enough views to determine a winner"),
    "no_clear"
  );
});

test("extracts titles from truncated Studio notification tails", () => {
  assert.equal(
    parseStudioNotification({
      rawText: "A/B test performed well for all How to Take Payment with Klarna: Results with very si"
    }).videoTitle,
    "How to Take Payment with Klarna"
  );
  assert.equal(
    parseStudioNotification({
      rawText: "A/B test won How to Build Custom Online Forms Faster with ChatGPT: We up"
    }).videoTitle,
    "How to Build Custom Online Forms Faster with ChatGPT"
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

test("filters content-list status blocks and title fragments from finish notifications", () => {
  assert.equal(
    isLikelyFinishNotification(
      "How to Create Connected Pages A/B Test completed — Public Mar 10 Published 996 How to Build Apps A/B Test completed Notifications All Analytics"
    ),
    false
  );
  assert.equal(
    isLikelyFinishNotification("ow to Design Your App with AI: Not enough views to determine a winner"),
    false
  );
});

test("deduplicates partial and complete copies of the same bell notification", () => {
  const events = expandConnectorEventInputs([
    {
      channelId: "UCh04CepWeaJT7wJUIgnmzJQ",
      rawText: "A/B test performed well for all Google Drive Tutorial for Beginners (+ OneDrive Comparison):"
    },
    {
      channelId: "UCh04CepWeaJT7wJUIgnmzJQ",
      rawText: "A/B test performed well for all Google Drive Tutorial for Beginners (+ OneDrive Comparison): Results with very similar performance"
    }
  ]);
  assert.equal(events.length, 1);
  assert.match(events[0].rawText, /Results with very similar performance/);
});

test("recovers canonical finish signals from hidden Studio accessibility labels", () => {
  const events = extractAccessibleFinishEventsFromScan({
    checkedAt: "2026-07-10T08:00:00.000Z",
    tabs: [
      {
        tabUrl: "https://studio.youtube.com/channel/UCIkU9Fe0OccRmqBMXRm1Q7A",
        channel: "AI Agents Podcast",
        pageIdentity: {
          accountHints: [
            "New notification. A/B test performed well for all Chatbots Are the New Websites: Results with very similar performance. 2 days ago",
            "Go to channel analytics"
          ]
        }
      }
    ]
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].channelId, "UCIkU9Fe0OccRmqBMXRm1Q7A");
  assert.equal(events[0].videoTitle, "Chatbots Are the New Websites");
  assert.equal(events[0].notificationAge, "2 days ago");
  assert.equal(events[0].source, "studio_accessibility_label");
});

test("collapses duplicate unmatched signals and rejects navigation-text contamination", () => {
  const result = consolidateUnmatchedFinishEvents([
    {
      eventId: "unknown-copy",
      videoTitle: "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder:",
      rawText: "A/B test inconclusive Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder: The test completed with no winner",
      detectedOutcome: "no_clear",
      observedAt: "2026-07-09T08:00:00Z"
    },
    {
      eventId: "known-copy",
      channel: "Jotform",
      channelId: "UCh04CepWeaJT7wJUIgnmzJQ",
      videoTitle: "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder",
      rawText: "A/B test inconclusive Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder: The test completed with no winner",
      detectedOutcome: "no_clear",
      notificationAge: "2 days ago",
      observedAt: "2026-07-10T08:00:00Z"
    },
    {
      eventId: "navigation-noise",
      videoTitle: "How to Build Custom Online Forms Faster with All Earn Known issues Policy Analytics Ideas News",
      rawText: "A/B test won How to Build Custom Online Forms Faster with All Earn Known issues Policy Analytics Ideas News",
      detectedOutcome: "finished_unknown",
      observedAt: "2026-07-10T08:00:00Z"
    }
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventId, "known-copy");
  assert.deepEqual(result.duplicateIds, ["unknown-copy"]);
  assert.deepEqual(result.rejectedIds, ["navigation-noise"]);
});

test("keeps same-title unmatched signals separate across known channel IDs", () => {
  const result = consolidateUnmatchedFinishEvents([
    { eventId: "one", channelId: "UConechannel123", videoTitle: "Shared Video", rawText: "A/B test inconclusive Shared Video: Not enough views to determine a winner", detectedOutcome: "no_clear" },
    { eventId: "two", channelId: "UCtwochannel456", videoTitle: "Shared Video", rawText: "A/B test inconclusive Shared Video: Not enough views to determine a winner", detectedOutcome: "no_clear" }
  ]);
  assert.equal(result.events.length, 2);
});

test("infers a missing legacy channel ID from the same extension event batch", () => {
  const result = consolidateUnmatchedFinishEvents([
    { eventId: "missing", source: "studio_bell", observedAt: "2026-06-30T06:02:04.745Z", videoTitle: "Why AI Is Like GPS for Life", rawText: "A/B test performed well for all Why AI Is Like GPS for Life: Results with very similar performance", detectedOutcome: "no_clear" },
    { eventId: "known", source: "studio_bell", observedAt: "2026-06-30T06:02:04.750Z", channelId: "UCIkU9Fe0OccRmqBMXRm1Q7A", videoTitle: "How ChatGPT Workspace Agents Work", rawText: "A/B test performed well for all How ChatGPT Workspace Agents Work: Results with very similar performance", detectedOutcome: "no_clear" }
  ]);
  assert.equal(result.events.find((event) => event.eventId === "missing").channelId, "UCIkU9Fe0OccRmqBMXRm1Q7A");
});

test("does not fuzzy-match a long notification through one generic shared token", () => {
  const match = matchFinishEventToRun(
    {
      videoTitle: "Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder",
      rawText: "A/B test inconclusive Enterprise Newsletter: June 2026 | Announcing Jotform AI App Builder: The test completed with no winner",
      channelId: "UCh04CepWeaJT7wJUIgnmzJQ"
    },
    [{
      testRunId: "wrong",
      videoId: "Zwxy1YypbnE",
      videoTitle: "What is Jotform?",
      currentYoutubeTitle: "What is Jotform?",
      youtubeChannelId: "UCh04CepWeaJT7wJUIgnmzJQ",
      channel: "Jotform",
      options: {}
    }]
  );
  assert.equal(match.run, null);
});

test("does not match a notification fragment without a video title", () => {
  const match = matchFinishEventToRun(
    { rawText: "Not enough views to determine a winner", channelId: "UCSIMCBt8yyTabkalWA05ZiA" },
    [{ testRunId: "run", videoTitle: "How to Design Your App with AI", youtubeChannelId: "UCSIMCBt8yyTabkalWA05ZiA" }]
  );
  assert.equal(match.run, null);
  assert.equal(match.matchedConfidence, "missing_video_title");
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

test("rejects video ID match when notification title clearly belongs to another video", () => {
  const activeRuns = [
    {
      testRunId: "wrong-video-id",
      videoId: "E2YxV9Dovsc",
      channel: "Jotform",
      videoTitle: "How to Use VLOOKUP and XLOOKUP in Excel | Step-by-step Guide"
    },
    {
      testRunId: "zoom-run",
      videoId: "zoom123",
      channel: "Jotform",
      videoTitle: "How to Configure Zoom Settings & AI Companion"
    }
  ];
  const event = parseStudioNotification({
    videoId: "E2YxV9Dovsc",
    channel: "Jotform",
    rawText: "A/B test won How to Configure Zoom Settings & AI Companion: We updated your video to use the winner"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run.testRunId, "zoom-run");
  assert.match(match.matchedConfidence, /^title_after_video_id_conflict:/);
});

test("keeps video ID match when notification title matches the same video", () => {
  const activeRuns = [
    {
      testRunId: "same-video",
      videoId: "E2YxV9Dovsc",
      channel: "Jotform",
      videoTitle: "How to Use VLOOKUP and XLOOKUP in Excel | Step-by-step Guide"
    }
  ];
  const event = parseStudioNotification({
    videoId: "E2YxV9Dovsc",
    channel: "Jotform",
    rawText: "A/B test performed well for all How to Use VLOOKUP and XLOOKUP in Excel | Step-by-step Guide: Results with very similar performance"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run.testRunId, "same-video");
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

test("keeps exact notification title matches lower confidence across channel name variants", () => {
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
  assert.equal(match.matchedConfidence, "title_channel_variant");
});

test("matches exact titles across known Jotform family channel aliases", () => {
  const activeRuns = [
    {
      testRunId: "pdf-editor-run",
      videoId: "pdf123",
      channel: "PDF Editor",
      videoTitle: "How to Edit a PDF Form"
    }
  ];
  const event = parseStudioNotification({
    channel: "Jotform PDF Editor",
    rawText: "A/B test performed well for all How to Edit a PDF Form: Results with very similar performance"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run.testRunId, "pdf-editor-run");
  assert.equal(match.matchedConfidence, "title_channel_alias");
});

test("does not title-match across different channel IDs", () => {
  const activeRuns = [
    {
      testRunId: "apps-run",
      videoId: "apps123",
      channel: "Apps",
      youtubeChannelId: "UCapps1234567890123456",
      videoTitle: "Introducing Jotform AI App Builder"
    }
  ];
  const event = parseStudioNotification({
    channel: "Jotform",
    channelId: "UCjotform123456789012",
    rawText: "A/B test performed well for all Introducing Jotform AI App Builder: Results with very similar performance"
  });
  const match = matchFinishEventToRun(event, activeRuns);
  assert.equal(match.run, null);
  assert.equal(match.matchedConfidence, "unmatched");
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
  assert.match(suggestions[0].reason, /channel name differs/);
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

test("sheet inspection reports non-empty tabs without recognizable A/B headers", () => {
  const inspection = inspectWorkbookSheets({
    sourceKind: "thumbnail",
    sheets: [
      {
        title: "New Thumbnail Tests",
        values: [
          ["Date", "Video", "Notes"],
          ["2026-07-01", "How to Preview your Form in Claude AI", "Needs setup"]
        ]
      },
      {
        title: "Jotform",
        values: [
          ["Published Date/ Test Start Date", "Video URL", "Thumbnail A", "Thumbnail B"],
          ["2026-07-01", "https://youtu.be/abc123XYZ_9", "A", "B"]
        ]
      }
    ]
  });
  assert.equal(inspection[0].hasContent, true);
  assert.equal(inspection[0].recognized, false);
  assert.equal(inspection[0].likelyTestData, false);
  assert.equal(inspection[1].recognized, true);
  assert.equal(inspection[1].testType, "thumbnail");
});

test("sheet inspection flags unrecognized tabs that still look like A/B test data", () => {
  const inspection = inspectWorkbookSheets({
    sourceKind: "title",
    sheets: [
      {
        title: "New layout",
        values: [
          ["Video", "Variant Alpha", "Variant Beta", "Start Date"],
          ["https://youtube.com/watch?v=abc123xyz89", "First title", "Second title", "2026-07-01"]
        ]
      }
    ]
  });
  assert.equal(inspection[0].recognized, false);
  assert.equal(inspection[0].likelyTestData, true);
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
