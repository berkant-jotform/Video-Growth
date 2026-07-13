import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishSignalSourceName,
  hasFreshConnectorData,
  isStudioFinishSignalSource
} from "../lib/finish-signal-source.mjs";

test("all real extension and pasted notification sources are identified as Studio signals", () => {
  for (const source of ["studio_bell", "studio_accessibility_label", "studio_page_status", "visible_text_block", "detector_modal"]) {
    assert.equal(isStudioFinishSignalSource(source), true);
  }
  assert.equal(isStudioFinishSignalSource("metadata"), false);
  assert.equal(isStudioFinishSignalSource(""), false);
  assert.equal(finishSignalSourceName("studio_accessibility_label"), "Studio notification");
  assert.equal(finishSignalSourceName("studio_page_status"), "Studio page status");
  assert.equal(finishSignalSourceName("metadata"), "Metadata observed");
});

test("recent passive coverage is scoped to the selected channels", () => {
  const now = Date.parse("2026-07-13T08:00:00Z");
  const statuses = [{
    active: true,
    channels: ["Jotform", "AI Agents"],
    lastSeenAt: "2026-07-13T07:55:00Z",
    payload: { lastStudioScan: { checkedAt: "2026-07-13T07:50:00Z" } }
  }];
  assert.equal(hasFreshConnectorData(statuses, ["Jotform"], now), true);
  assert.equal(hasFreshConnectorData(statuses, ["Jotform", "AI Agents"], now), true);
  assert.equal(hasFreshConnectorData(statuses, ["Apps"], now), false);
  assert.equal(hasFreshConnectorData(statuses, [], now), true);
  assert.equal(hasFreshConnectorData(statuses, ["Jotform"], now + 3 * 60 * 60 * 1000), false);
});
