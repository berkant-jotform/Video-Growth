import test from "node:test";
import assert from "node:assert/strict";
import { connectorCoverageLabels, selectConnectorTarget } from "../lib/connector-routing.mjs";

const now = new Date().toISOString();

test("routes a scoped check to the browser with the matching open watcher", () => {
  const result = selectConnectorTarget([
    {
      connectorId: "general",
      active: true,
      version: "1.0.0",
      channels: ["Jotform", "Apps"],
      lastSeenAt: now,
      payload: { capabilities: { durableJobs: true }, ownedWatchers: [{ label: "Jotform" }] }
    },
    {
      connectorId: "apps-browser",
      active: true,
      version: "1.0.0",
      channels: ["Apps"],
      lastSeenAt: now,
      payload: { capabilities: { durableJobs: true }, ownedWatchers: [{ label: "Apps" }] }
    }
  ], ["Apps"]);
  assert.equal(result, "apps-browser");
});

test("does not target an inactive or pre-1.0 browser", () => {
  const result = selectConnectorTarget([
    { connectorId: "old", active: true, version: "0.3.4", channels: ["Jotform"], lastSeenAt: now, payload: {} },
    { connectorId: "offline", active: false, version: "1.0.0", channels: ["Jotform"], lastSeenAt: now, payload: { capabilities: { durableJobs: true } } }
  ], ["Jotform"]);
  assert.equal(result, "");
});

test("coverage labels include owned watchers and identified Studio tabs", () => {
  assert.deepEqual(connectorCoverageLabels({
    payload: {
      ownedWatchers: [{ label: "Jotform" }],
      studioTabs: [{ channel: "AI Agents" }, { channel: "Jotform" }]
    }
  }), ["Jotform", "AI Agents"]);
});
