import test from "node:test";
import assert from "node:assert/strict";
import {
  channelIdentityMatches,
  channelIdentityConflict,
  finalJobStatus,
  nextRetryAt,
  shouldRetryOutboxItem,
  stableEventKey,
  summarizeChannelCoverage,
  recentlySeenEvent
} from "../extension/reliability-core.js";

test("stable event identity ignores changing relative age labels", () => {
  const base = {
    notificationId: "notification-123",
    channelId: "UCjotform",
    videoTitle: "Example video",
    rawText: "A/B test performed well for all Example video: Results with very similar performance"
  };
  assert.equal(
    stableEventKey({ ...base, notificationAge: { label: "1 day ago" } }),
    stableEventKey({ ...base, notificationAge: { label: "2 days ago" } })
  );
});

test("fallback event identity removes age text from notification copy", () => {
  const first = stableEventKey({ rawText: "A/B test won Example 1 day ago", channelId: "UC1" });
  const second = stableEventKey({ rawText: "A/B test won Example 2 days ago", channelId: "UC1" });
  assert.equal(first, second);
});

test("exact channel IDs prevent similar channels from merging", () => {
  assert.equal(channelIdentityMatches({ channelId: "UC1", channel: "Jotform" }, { channelId: "UC2", channel: "Jotform" }), false);
  assert.equal(channelIdentityMatches({ channel: "Jotform" }, { channel: "Jotform Workflow" }), false);
  assert.equal(channelIdentityMatches({ channelId: "UC1" }, { channelId: "UC1" }), true);
});

test("watcher identity accepts video pages but rejects real cross-channel evidence", () => {
  const expected = "UCexpected123456";
  assert.equal(channelIdentityConflict(expected, [], "https://studio.youtube.com/video/abc123/edit"), false);
  assert.equal(channelIdentityConflict(expected, [expected], "https://studio.youtube.com/video/abc123/edit"), false);
  assert.equal(channelIdentityConflict(expected, [], "https://studio.youtube.com/channel/UCdifferent12345/videos"), true);
  assert.equal(channelIdentityConflict(expected, ["UCdifferent12345"], "https://studio.youtube.com/video/abc123/edit"), true);
});

test("channel coverage remains partial until every requested channel is checked", () => {
  const coverage = summarizeChannelCoverage([
    { channel: "Jotform", checked: true, bellRead: true, ok: true, candidates: 2, received: 2 },
    { channel: "AI Agents", checked: false, ok: false, error: "Tab unavailable" }
  ], ["Jotform", "AI Agents", "Apps"]);
  assert.deepEqual(coverage.map((item) => item.status), ["checked", "failed", "missing_tab"]);
  assert.equal(finalJobStatus([coverage]), "partial");
  assert.equal(finalJobStatus(coverage, true), "cancelled");
});

test("a technically successful tab is partial until the bell was actually read", () => {
  const [coverage] = summarizeChannelCoverage([
    { channel: "Jotform", checked: true, bellRead: false, ok: true }
  ], ["Jotform"]);
  assert.equal(coverage.status, "partial");
  assert.equal(finalJobStatus([coverage]), "partial");
});

test("content scan dedupe expires so a later same-video retest can emit", () => {
  const cache = new Map();
  const event = { videoId: "abc", rawText: "A/B test won Example", url: "https://studio.youtube.com/video/abc/edit" };
  assert.equal(recentlySeenEvent(cache, event, 1_000, 5_000), false);
  assert.equal(recentlySeenEvent(cache, event, 2_000, 5_000), true);
  assert.equal(recentlySeenEvent(cache, event, 7_001, 5_000), false);
});

test("outbox retries use future backoff and respect expiration", () => {
  const now = Date.UTC(2026, 7, 31, 12, 0, 0);
  assert.equal(shouldRetryOutboxItem({ nextAttemptAt: new Date(now - 1).toISOString() }, now), true);
  assert.equal(shouldRetryOutboxItem({ nextAttemptAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(shouldRetryOutboxItem({ expiresAt: new Date(now - 1).toISOString() }, now), false);
  assert.ok(new Date(nextRetryAt(3, now)).getTime() > now);
});
