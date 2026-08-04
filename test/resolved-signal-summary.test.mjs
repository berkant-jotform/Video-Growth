import assert from "node:assert/strict";
import test from "node:test";
import { mergeResolvedFinishSignalChannels } from "../lib/resolved-signal-summary.mjs";

test("resolved finish summaries merge canonical channel variants without losing counts", () => {
  const summary = mergeResolvedFinishSignalChannels([
    { channel: "Jotform", resolved_count: 10, latest_finished_at: "2026-08-03T10:00:00Z" },
    { channel: "Jotform.com", resolved_count: 4, latest_finished_at: "2026-08-04T11:00:00Z" },
    { channel: "AI Agents", resolved_count: 2, latest_finished_at: "2026-08-02T09:00:00Z" }
  ], 30);

  assert.equal(summary.total, 16);
  assert.deepEqual(summary.channels.Jotform, {
    count: 14,
    latestFinishedAt: "2026-08-04T11:00:00Z"
  });
  assert.equal(summary.channels["AI Agents"].count, 2);
});
