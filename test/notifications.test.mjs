import test from "node:test";
import assert from "node:assert/strict";
import { emailSubject, filterQueue } from "../lib/notification-rules.mjs";

test("notification rules filter by channel, test type, and status", () => {
  const queue = [
    {
      channel: "Jotform",
      testType: "thumbnail",
      queueStatus: "confirmed_finished",
      videoTitle: "A"
    },
    {
      channel: "AI Agents Podcast",
      testType: "title",
      queueStatus: "watching",
      videoTitle: "B"
    },
    {
      channel: "Jotform Apps",
      testType: "thumbnail",
      queueStatus: "applied_change_observed",
      videoTitle: "C"
    }
  ];

  const filtered = filterQueue(queue, {
    channels: ["Jotform"],
    testTypes: ["Thumbnail"],
    statuses: ["confirmed finished"]
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].videoTitle, "A");
});

test("empty notification rules include the full shared queue", () => {
  const queue = [
    { channel: "Jotform", testType: "title", queueStatus: "watching" },
    { channel: "AI Agents", testType: "thumbnail", queueStatus: "confirmed_finished" }
  ];

  assert.equal(filterQueue(queue, {}).length, 2);
});

test("email subject prioritizes action count over noisy total", () => {
  const subject = emailSubject(
    {
      total: 63,
      confirmedFinished: 1,
      appliedChangeObserved: 0,
      pastDueCheck: 62
    },
    { displayName: "BG" }
  );

  assert.equal(subject, "YouTube A/B Tests for BG: 1 ready to check");
});
