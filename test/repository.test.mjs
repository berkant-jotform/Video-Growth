import assert from "node:assert/strict";
import test from "node:test";
import { deriveQueueStatus } from "../lib/queue-status.mjs";

test("sheet result entered after tool action does not reopen active queue", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "result_logged",
      startDate: "2020-01-01"
    }),
    "result_logged"
  );
});

test("unexpected source drift after tool action remains reviewable", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "running",
      startDate: "2020-01-01"
    }),
    "sheet_changed_after_done"
  );
});
