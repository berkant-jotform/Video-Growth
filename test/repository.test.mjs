import assert from "node:assert/strict";
import test from "node:test";
import { deriveQueueStatus, isActionableQueueStatus, isActionConflict, sheetOutcomeAction } from "../lib/queue-status.mjs";

test("default action queue excludes metadata observations and passive monitoring", () => {
  assert.equal(isActionableQueueStatus("confirmed_finished"), true);
  assert.equal(isActionableQueueStatus("past_due_check"), true);
  assert.equal(isActionableQueueStatus("action_conflict"), true);
  assert.equal(isActionableQueueStatus("applied_change_observed"), false);
  assert.equal(isActionableQueueStatus("watching"), false);
  assert.equal(isActionableQueueStatus("uncovered"), false);
});

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

test("source drift after a tool action stays closed unless a real result conflicts", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "running",
      startDate: "2020-01-01"
    }),
    "done"
  );
});

test("blank sheet after tool action stays closed", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "running",
      latestAction: "B",
      detectedOutcome: "result_missing",
      suggestedWinner: "",
      startDate: "2020-01-01"
    }),
    "done"
  );
});

test("blank sheet after tool action does not create an action conflict", () => {
  assert.equal(
    isActionConflict({
      latestAction: "B",
      baseQueueStatus: "running",
      detectedOutcome: "result_missing",
      suggestedWinner: ""
    }),
    false
  );
});

test("matching sheet result after tool action stays closed", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "result_logged",
      latestAction: "B",
      detectedOutcome: "winner_b",
      suggestedWinner: "B",
      startDate: "2020-01-01"
    }),
    "result_logged"
  );
});

test("conflicting sheet result after tool action becomes action conflict", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "result_logged",
      latestAction: "B",
      detectedOutcome: "winner_a",
      suggestedWinner: "A",
      startDate: "2020-01-01"
    }),
    "action_conflict"
  );
});

test("conflicting sheet-marked-done result after tool action becomes action conflict", () => {
  assert.equal(
    deriveQueueStatus({
      drifted: true,
      hasAction: true,
      baseQueueStatus: "sheet_marked_done",
      latestAction: "B",
      detectedOutcome: "winner_a",
      suggestedWinner: "A",
      startDate: "2020-01-01"
    }),
    "action_conflict"
  );
});

test("sheet no-clear winner normalizes to no-clear action", () => {
  assert.equal(
    sheetOutcomeAction({
      baseQueueStatus: "result_logged",
      detectedOutcome: "no_clear",
      suggestedWinner: "No clear winner"
    }),
    "NO_CLEAR"
  );
});
