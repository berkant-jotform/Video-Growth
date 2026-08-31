import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesPostEnrichmentScanFilters,
  matchesPreEnrichmentScanFilters,
  pruneChannelFilters
} from "../lib/scan-scope.mjs";

const jotformScope = { channels: ["Jotform"], testType: "" };

test("keeps generic thumbnail tabs until YouTube resolves the real channel", () => {
  const record = {
    sourceKind: "thumbnail",
    testType: "thumbnail",
    channel: "With Podo",
    sheetName: "With Podo",
    youtubeChannelTitle: "",
    youtubeChannelId: ""
  };

  assert.equal(matchesPreEnrichmentScanFilters(record, jotformScope), true);
  assert.equal(
    matchesPostEnrichmentScanFilters(
      { ...record, youtubeChannelTitle: "Jotform", youtubeChannelId: "UCh04CepWeaJT7wJUIgnmzJQ" },
      jotformScope
    ),
    true
  );
});

test("persists a generic thumbnail row after YouTube resolves another channel", () => {
  const record = {
    sourceKind: "thumbnail",
    testType: "thumbnail",
    channel: "With Podo",
    sheetName: "With Podo",
    youtubeChannelTitle: "AI Agents",
    youtubeChannelId: "UC-another-channel"
  };

  assert.equal(matchesPostEnrichmentScanFilters(record, jotformScope), true);
});

test("keeps a generic thumbnail row when YouTube enrichment is unavailable", () => {
  const record = {
    sourceKind: "thumbnail",
    testType: "thumbnail",
    channel: "With Podo",
    sheetName: "With Podo",
    youtubeChannelTitle: "",
    youtubeChannelId: ""
  };

  assert.equal(matchesPostEnrichmentScanFilters(record, jotformScope), true);
});

test("removes deleted channels from browser-local scan scope", () => {
  assert.deepEqual(
    pruneChannelFilters(["Jotform", "Apps", "Removed channel"], ["Jotform", "Apps", "AI Agents"]),
    ["Jotform", "Apps"]
  );
});
