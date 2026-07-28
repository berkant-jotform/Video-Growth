import assert from "node:assert/strict";
import test from "node:test";
import {
  displayHistoryChannel,
  filterHistoryItems,
  historyFilterOptions
} from "../lib/history-filters.mjs";

const items = [
  historyItem({
    videoTitle: "Build a Jotform workflow",
    channel: "Jotform - A/B",
    testType: "title",
    action: "B"
  }),
  historyItem({
    videoTitle: "Apps thumbnail result",
    channel: "Jotform Apps Channel",
    testType: "thumbnail",
    action: "NO_CLEAR"
  }),
  historyItem({
    videoTitle: "AI agent result",
    channel: "AI Agents AB Test",
    testType: "title",
    action: "A"
  })
];

test("History filter options stay canonical and independent of the current search", () => {
  const options = historyFilterOptions(items);
  assert.deepEqual(options.channels, ["Jotform", "AI Agents", "Apps"]);
  assert.deepEqual(options.actions, ["A", "B", "NO_CLEAR"]);
  assert.equal(displayHistoryChannel("Jotform -  AB"), "Jotform");
});

test("History combines search, channel, outcome, and test type without stale state", () => {
  assert.deepEqual(
    filterHistoryItems(items, {
      search: "workflow",
      channel: "Jotform",
      action: "B",
      testType: "title"
    }).map((item) => item.videoTitle),
    ["Build a Jotform workflow"]
  );
  assert.equal(
    filterHistoryItems(items, {
      search: "apps",
      channel: "Jotform",
      action: "all",
      testType: "all"
    }).length,
    0
  );
  assert.equal(
    filterHistoryItems(items, {
      search: "apps",
      channel: "Apps",
      action: "NO_CLEAR",
      testType: "thumbnail"
    }).length,
    1
  );
});

function historyItem({
  videoTitle,
  channel,
  testType,
  action
}) {
  return {
    videoTitle,
    channel,
    testType,
    videoId: "video-id",
    action: {
      action,
      actorName: "BG",
      note: ""
    }
  };
}
