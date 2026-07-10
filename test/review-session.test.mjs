import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewQueue } from "../lib/review-session.mjs";

test("review session includes only actionable confirmed work", () => {
  const runs = [
    { testRunId: "watch", queueStatus: "watching", channel: "Jotform", testType: "title" },
    { testRunId: "done", queueStatus: "confirmed_finished", channel: "Jotform", testType: "title" },
    { testRunId: "observed", queueStatus: "applied_change_observed", channel: "Jotform", testType: "thumbnail" }
  ];
  assert.deepEqual(buildReviewQueue(runs).map((run) => run.testRunId), ["done"]);
});

test("review session prioritizes conflicts and thumbnails", () => {
  const runs = [
    { testRunId: "title", queueStatus: "confirmed_finished", channel: "Jotform", testType: "title" },
    { testRunId: "thumb", queueStatus: "confirmed_finished", channel: "Jotform", testType: "thumbnail" },
    { testRunId: "conflict", queueStatus: "action_conflict", channel: "AI Agents", testType: "title" }
  ];
  assert.deepEqual(buildReviewQueue(runs).map((run) => run.testRunId), ["conflict", "thumb", "title"]);
});

test("review session respects filters and local skips", () => {
  const runs = [
    { testRunId: "one", queueStatus: "confirmed_finished", channel: "Jotform", testType: "title" },
    { testRunId: "two", queueStatus: "confirmed_finished", channel: "Apps", testType: "thumbnail" }
  ];
  assert.deepEqual(buildReviewQueue(runs, { channel: "Apps", testType: "thumbnail" }).map((run) => run.testRunId), ["two"]);
  assert.deepEqual(buildReviewQueue(runs, { skippedIds: ["one"] }).map((run) => run.testRunId), ["two"]);
});
