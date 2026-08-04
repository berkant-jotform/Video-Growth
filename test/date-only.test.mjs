import assert from "node:assert/strict";
import test from "node:test";
import { formatDateOnly } from "../lib/date-only.mjs";

test("keeps SQL-style local-midnight dates on their calendar day", () => {
  const localMidnight = new Date(2026, 6, 10, 0, 0, 0);
  assert.equal(formatDateOnly(localMidnight), "2026-07-10");
});

test("keeps an ISO date string without timezone shifting it", () => {
  assert.equal(formatDateOnly("2026-07-10T00:00:00.000Z"), "2026-07-10");
});

test("rejects invalid date-only values", () => {
  assert.equal(formatDateOnly("not-a-date"), "");
});
