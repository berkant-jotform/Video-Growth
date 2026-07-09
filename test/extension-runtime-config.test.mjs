import test from "node:test";
import assert from "node:assert/strict";
import {
  parseExtensionRuntimeConfigJson,
  safeParseExtensionRuntimeConfigJson,
  normalizeExtensionRuntimeConfig
} from "../lib/extension-runtime-config.mjs";

test("normalizes extension runtime config with safe guardrails", () => {
  const config = normalizeExtensionRuntimeConfig({
    version: "custom",
    minTextLength: 1,
    maxTextLength: 9000,
    maxEvents: 999,
    waitAfterOpenMs: 1,
    waitForRowsMs: 999999,
    scrollRounds: 99,
    scrollDelayMs: 1,
    scanOrder: "studio_first",
    includeSeenOnManualScan: false,
    finishPhrases: ["custom finish"],
    ignorePhrases: ["custom ignore"]
  });

  assert.equal(config.version, "custom");
  assert.equal(config.minTextLength, 8);
  assert.equal(config.maxTextLength, 2000);
  assert.equal(config.maxEvents, 120);
  assert.equal(config.waitAfterOpenMs, 300);
  assert.equal(config.waitForRowsMs, 12000);
  assert.equal(config.scrollRounds, 8);
  assert.equal(config.scrollDelayMs, 150);
  assert.equal(config.scanOrder, "studio_first");
  assert.equal(config.includeSeenOnManualScan, false);
  assert.ok(config.finishPhrases.includes("A/B test won"));
  assert.ok(config.finishPhrases.includes("custom finish"));
  assert.ok(config.ignorePhrases.includes("A/B Test running"));
  assert.ok(config.ignorePhrases.includes("custom ignore"));
});

test("rejects invalid extension runtime config JSON", () => {
  assert.throws(
    () => parseExtensionRuntimeConfigJson("{bad json"),
    /valid JSON/
  );
});

test("safe parser falls back to defaults for invalid runtime config JSON", () => {
  const result = safeParseExtensionRuntimeConfigJson("{bad json");
  assert.match(result.error, /valid JSON/);
  assert.equal(result.config.scanOrder, "youtube_first");
  assert.ok(result.config.finishPhrases.includes("A/B test won"));
});
