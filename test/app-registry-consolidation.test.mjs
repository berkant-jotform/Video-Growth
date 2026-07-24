import assert from "node:assert/strict";
import { test } from "node:test";
import { planAppManagedConsolidation } from "../lib/app-registry-consolidation.mjs";

test("consolidates repeated app records for the same video and test type", () => {
  const plans = planAppManagedConsolidation([
    appRun({ testRunId: "old", videoId: "video-1", matchedEventCount: 1 }),
    appRun({ testRunId: "chosen", videoId: "video-1", activeActionCount: 1 }),
    appRun({ testRunId: "other-type", videoId: "video-1", testType: "thumbnail" })
  ]);
  assert.deepEqual(plans, [{
    canonicalId: "chosen",
    duplicateIds: ["old"],
    key: "video|video-1|title"
  }]);
});

test("does not merge title-only app records across channels", () => {
  const plans = planAppManagedConsolidation([
    appRun({ testRunId: "jotform", videoId: "", videoTitle: "Same title", channel: "Jotform" }),
    appRun({ testRunId: "apps", videoId: "", videoTitle: "Same title", channel: "Apps" })
  ]);
  assert.deepEqual(plans, []);
});

test("ignores archived and non-app records", () => {
  const plans = planAppManagedConsolidation([
    appRun({ testRunId: "active", videoId: "video-1" }),
    appRun({ testRunId: "archived", videoId: "video-1", status: "source_removed" }),
    appRun({ testRunId: "sheet", videoId: "video-1", sourceKind: "title" })
  ]);
  assert.deepEqual(plans, []);
});

function appRun(overrides = {}) {
  return {
    testRunId: "run",
    videoId: "",
    sourceKind: "app_registry",
    status: "needs_review",
    testType: "title",
    channel: "Jotform",
    videoTitle: "Example",
    currentYoutubeTitle: "",
    youtubeChannelId: "",
    youtubeChannelTitle: "",
    updatedAt: "2026-07-24T08:00:00Z",
    activeActionCount: 0,
    matchedEventCount: 0,
    ...overrides
  };
}
