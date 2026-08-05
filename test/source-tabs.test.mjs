import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inactiveSourceTabs,
  parseExcludedSheetTabs,
  parseSourceTabPolicies,
  sourceTabExclusion,
  sourceTabPolicy,
  stringifyExcludedSheetTabs,
  stringifySourceTabPolicies
} from "../lib/source-tabs.mjs";

test("parses and normalizes configured source-tab exclusions", () => {
  const value = stringifyExcludedSheetTabs([{ sourceKind: "TITLE", sheetName: "Archive" }]);
  assert.deepEqual(parseExcludedSheetTabs(value), [{ sourceKind: "title", sheetName: "Archive" }]);
  assert.equal(sourceTabExclusion({ sourceKind: "title", sheetName: "archive" }, value).source, "settings");
});

test("automatically excludes published-video inventory tabs", () => {
  const result = sourceTabExclusion({ sourceKind: "title", sheetName: "Published Videos With Ads (Existing)" }, []);
  assert.equal(result.excluded, true);
  assert.equal(result.source, "system");
});

test("keeps normal A/B tabs included", () => {
  assert.equal(sourceTabExclusion({ sourceKind: "title", sheetName: "AI Agents AB Test" }, []).excluded, false);
});

test("supports active, archive, and ignore lifecycle policies", () => {
  const value = stringifySourceTabPolicies([
    { sourceKind: "thumbnail", sheetName: "Current tests", mode: "active" },
    { sourceKind: "thumbnail", sheetName: "2025 archive", mode: "archive" },
    { sourceKind: "title", sheetName: "Notes", mode: "ignore" }
  ]);
  assert.deepEqual(parseSourceTabPolicies(value), [
    { sourceKind: "thumbnail", sheetName: "Current tests", mode: "active" },
    { sourceKind: "thumbnail", sheetName: "2025 archive", mode: "archive" },
    { sourceKind: "title", sheetName: "Notes", mode: "ignore" }
  ]);
  assert.equal(sourceTabPolicy(
    { sourceKind: "thumbnail", sheetName: "2025 ARCHIVE" },
    value
  ).mode, "archive");
  assert.deepEqual(inactiveSourceTabs(value, [], "thumbnail"), [
    { sourceKind: "thumbnail", sheetName: "2025 archive", mode: "archive" }
  ]);
});

test("explicit active policy can reactivate a legacy excluded tab", () => {
  const result = sourceTabPolicy(
    { sourceKind: "thumbnail", sheetName: "Current tests" },
    [{ sourceKind: "thumbnail", sheetName: "Current tests", mode: "active" }],
    [{ sourceKind: "thumbnail", sheetName: "Current tests" }]
  );
  assert.equal(result.mode, "active");
  assert.equal(result.source, "settings");
});

test("system inventory tabs remain ignored even when configured active", () => {
  const result = sourceTabPolicy(
    { sourceKind: "title", sheetName: "Published Videos With Ads (Existing)" },
    [{ sourceKind: "title", sheetName: "Published Videos With Ads (Existing)", mode: "active" }]
  );
  assert.equal(result.mode, "ignore");
  assert.equal(result.source, "system");
});
