import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeIdentityAliasesForPersistence,
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

test("duplicate persistence aliases with the same owner collapse to one row", () => {
  const rows = [
    { alias_value: "content:video:title:hash", test_id: "test_existing" },
    { alias_value: "content:video:title:hash", test_id: "test_existing" }
  ];
  assert.deepEqual(dedupeIdentityAliasesForPersistence(rows), [rows[0]]);
});

test("duplicate persistence aliases with different owners fail closed", () => {
  assert.throws(
    () => dedupeIdentityAliasesForPersistence([
      { alias_value: "content:video:title:hash", test_id: "test_one" },
      { alias_value: "content:video:title:hash", test_id: "test_two" }
    ]),
    (error) => {
      assert.equal(error.code, "ambiguous_identity_alias_batch");
      assert.deepEqual(error.identityConflict.conflictingTestIds, ["test_one", "test_two"]);
      return true;
    }
  );
});

test("reused sheet rows do not override a matching content identity", () => {
  const current = baseRecord({ rowNumber: 42 });
  const aliases = identityAliases(current);
  const sheetAlias = aliases.find((alias) => alias.startsWith("sheet:"));
  const contentAlias = aliases.find((alias) => alias.startsWith("content:"));
  const aliasToTestId = new Map([
    [sheetAlias, "test_previous_row_occupant"],
    [contentAlias, "test_current_video"]
  ]);
  const aliasTargets = new Map([
    [sheetAlias, {
      testId: "test_previous_row_occupant",
      videoId: "differentVideoId",
      testType: "title"
    }],
    [contentAlias, {
      testId: "test_current_video",
      videoId: current.videoId,
      testType: current.testType,
      contentHash: testContentHash(current)
    }]
  ]);

  const resolved = resolvePersistedTestId({
    record: current,
    aliasToTestId,
    aliasTargets
  });

  assert.equal(resolved.testId, "test_current_video");
  assert.equal(resolved.match, "alias");
  assert.equal(resolved.ambiguous, false);
});

test("reused sheet rows fall back to the matching existing video identity", () => {
  const current = baseRecord({ rowNumber: 42 });
  const sheetAlias = identityAliases(current).find((alias) => alias.startsWith("sheet:"));
  const aliasToTestId = new Map([[sheetAlias, "test_previous_row_occupant"]]);
  const aliasTargets = new Map([[sheetAlias, {
    testId: "test_previous_row_occupant",
    videoId: "differentVideoId",
    testType: "title"
  }]]);

  const resolved = resolvePersistedTestId({
    record: current,
    aliasToTestId,
    aliasTargets,
    existingTests: [{
      testId: "test_current_video",
      videoId: current.videoId,
      testType: current.testType,
      contentHash: testContentHash(current),
      startDate: current.startDate
    }]
  });

  assert.equal(resolved.testId, "test_current_video");
  assert.equal(resolved.match, "existing_test");
  assert.equal(resolved.ambiguous, false);
});

test("conflicting immutable aliases remain ambiguous", () => {
  const current = baseRecord();
  const aliases = identityAliases(current);
  const contentAlias = aliases.find((alias) => alias.startsWith("content:"));
  const datedAlias = aliases.find((alias) => alias.startsWith("video-date:"));
  const resolved = resolvePersistedTestId({
    record: current,
    aliasToTestId: new Map([
      [contentAlias, "test_content"],
      [datedAlias, "test_date"]
    ])
  });

  assert.equal(resolved.testId, "");
  assert.equal(resolved.match, "ambiguous_alias");
  assert.equal(resolved.ambiguous, true);
  assert.deepEqual(resolved.conflictingTestIds.toSorted(), ["test_content", "test_date"]);
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
