import assert from "node:assert/strict";
import { test } from "node:test";
import { appManagedRunIdentity, inferFinishEventTestType } from "../lib/app-registry.mjs";

test("app registry reuses a stable run across repeated notification scans", () => {
  const event = { videoId: "video-1", rawText: "A/B test inconclusive Example", occurredAt: "2026-07-10T08:00:00Z" };
  assert.equal(appManagedRunIdentity(event).testRunId, appManagedRunIdentity({ ...event, observedAt: "2026-07-12T10:00:00Z" }).testRunId);
});

test("app registry does not invent a retest from a later repeated signal", () => {
  const first = appManagedRunIdentity({ videoId: "video-1", occurredAt: "2026-07-10T08:00:00Z" });
  const later = appManagedRunIdentity({ videoId: "video-1", occurredAt: "2026-08-01T08:00:00Z" });
  assert.equal(first.testRunId, later.testRunId);
});

test("app registry infers thumbnail signals without requiring a sheet", () => {
  assert.equal(inferFinishEventTestType({ rawText: "Thumbnail test completed" }), "thumbnail");
  assert.equal(inferFinishEventTestType({ rawText: "A/B test won Example" }), "title");
});
