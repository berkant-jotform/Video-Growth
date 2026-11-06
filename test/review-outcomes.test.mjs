import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeReviewDecision, reviewActionLabel, reviewOutcomeValue, sameReviewDecision } from "../lib/review-outcomes.mjs";

const cases = [
  ["INSUFFICIENT_VIEWS", "Not enough viewers / views"],
  ["INSUFFICIENT_IMPRESSIONS", "Not enough impressions"],
  ["INSUFFICIENT_DATA", "Not enough data"],
  ["PERFORMED_SIMILARLY", "Performed similarly"],
  ["NO_WINNER", "No clear winner"]
];

test("specific review reasons retain report compatibility and round-trip into history", () => {
  for (const [choice, label] of cases) {
    const saved = normalizeReviewDecision(choice, "Additional context");
    assert.equal(saved.action, "NO_CLEAR");
    assert.equal(saved.note, `Review reason: ${label}\nAdditional context`);
    assert.equal(reviewOutcomeValue(saved.action, saved.note), choice);
    assert.equal(reviewActionLabel(saved.action, saved.note), label);
  }
});

test("legacy decisions remain distinct from new reasons without rewriting old records", () => {
  assert.equal(reviewActionLabel("NO_CLEAR", "Old note"), "Not enough views / No clear winner");
  for (const action of ["A", "B", "C", "NO_CLEAR", "KEPT_CURRENT", "RETEST_LATER", "SKIP"]) {
    assert.deepEqual(normalizeReviewDecision(action, "Old note"), { action, note: "Old note" });
  }
});

test("retries deduplicate while changing a no-clear reason is a correctable decision", () => {
  const views = normalizeReviewDecision("INSUFFICIENT_VIEWS");
  const data = normalizeReviewDecision("INSUFFICIENT_DATA");
  assert.equal(sameReviewDecision(views.action, views.note, views.action, views.note), true);
  assert.equal(sameReviewDecision(views.action, views.note, data.action, data.note), false);
  assert.equal(sameReviewDecision("NO_CLEAR", "", views.action, views.note), false);
  assert.equal(sameReviewDecision("A", "", "B", ""), false);
});

test("the real completion route passes canonical actions and exact reasons to storage", async () => {
  // Keep the real route and normalizer; replace external auth/storage/Next transport.
  // No production records or credentials are used by this integration boundary test.
  let source = await readFile(new URL("../app/api/actions/complete/route.js", import.meta.url), "utf8");
  source = source.replace(/import \{ requireSession \}[^;]+;/, 'const requireSession = async () => ({ actorName: "QA" });');
  source = source.replace(/import \{ completeTestRun, resolveReviewItem \}[^;]+;/, `
    export const testCalls = [];
    const completeTestRun = async input => { testCalls.push(input); return {test: input, actionId: "test-action"}; };
    const resolveReviewItem = async input => { testCalls.push(input); return {resolutionId: "test-resolution"}; };
  `);
  source = source.replace('"@/lib/review-outcomes.mjs"', JSON.stringify(new URL("../lib/review-outcomes.mjs", import.meta.url).href));
  source = source.replace(/import \{ badRequest, errorJson, json \}[^;]+;/, `
    const json = (value, init) => Response.json(value, init);
    const badRequest = message => Object.assign(new Error(message), {status: 400});
    const errorJson = error => json({ok:false,error:error.message},{status:error.status || 500});
  `);
  const route = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  for (const [choice, label] of cases) {
    for (const testRunId of ["test-run", "finish_event:test-event"]) {
      const request = new Request("http://localhost/api/actions/complete", {method:"POST",body:JSON.stringify({testRunId, action:choice})});
      const response = await route.POST(request);
      assert.equal(response.status, 200);
      const stored = route.testCalls.at(-1);
      assert.equal(stored.action, "NO_CLEAR");
      assert.equal(stored.note, `Review reason: ${label}`);
      assert.equal(stored.actorName, "QA");
    }
  }
  const before = route.testCalls.length;
  const response = await route.POST(new Request("http://localhost", {method:"POST",body:JSON.stringify({testRunId:"test-run",action:"MADE_UP_REASON"})}));
  assert.equal(response.status,400);
  assert.equal(route.testCalls.length,before);
});
