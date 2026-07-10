import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExcludedSheetTabs, sourceTabExclusion, stringifyExcludedSheetTabs } from "../lib/source-tabs.mjs";

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
