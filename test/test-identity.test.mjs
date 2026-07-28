import assert from "node:assert/strict";
import test from "node:test";
import {
  identityAliases,
  resolvePersistedTestId,
  testContentHash
} from "../lib/test-identity.mjs";

function baseRecord(overrides = {}) {
  return {
    sourceKind: "title",
    spreadsheetId: "sheet",
    sheetName: "Jotform",
    rowNumber: 12,
    videoId: "abc123XYZ89",
    testType: "title",
    startDate: "2026-07-01",
    options: { A: "Original title", B: "Alternative title" },
    ...overrides
  };
}

test("editing an option title does not change a persisted test ID", () => {
  const initial = baseRecord();
  const aliasToTestId = new Map(identityAliases(initial).map((alias) => [alias, "test_existing"]));
  const edited = baseRecord({ options: { A: "Original title", B: "Edited title" } });
  const resolved = resolvePersistedTestId({ record: edited, aliasToTestId });
  assert.equal(resolved.testId, "test_existing");
  assert.equal(resolved.match, "alias");
});

test("moving a sheet row does not change identity when content is unchanged", () => {
  const initial = baseRecord();
  const aliasToTestId = new Map(identityAliases(initial).map((alias) => [alias, "test_existing"]));
  const moved = baseRecord({ rowNumber: 42 });
  const resolved = resolvePersistedTestId({ record: moved, aliasToTestId });
  assert.equal(testContentHash(moved), testContentHash(initial));
  assert.equal(resolved.testId, "test_existing");
});

test("a genuinely different dated test can receive a new surrogate ID", () => {
  const initial = baseRecord();
  const existingTests = [{
    testId: "test_existing",
    videoId: initial.videoId,
    testType: initial.testType,
    contentHash: testContentHash(initial),
    startDate: initial.startDate
  }];
  const retest = baseRecord({
    rowNumber: 51,
    startDate: "2026-07-20",
    options: { A: "Original title", B: "Third title" }
  });
  const resolved = resolvePersistedTestId({
    record: retest,
    existingTests,
    createId: () => "test_new"
  });
  assert.equal(resolved.testId, "test_new");
  assert.equal(resolved.match, "new");
});
