export const EXTENSION_RUNTIME_CONFIG_KEY = "EXTENSION_RUNTIME_CONFIG_JSON";

export const DEFAULT_EXTENSION_RUNTIME_CONFIG = {
  version: "2026-07-09.1",
  minTextLength: 18,
  maxTextLength: 700,
  maxEvents: 60,
  waitAfterOpenMs: 1200,
  waitForRowsMs: 4500,
  scrollRounds: 3,
  scrollDelayMs: 650,
  scanOrder: "youtube_first",
  openYoutubeFallback: false,
  includeSeenOnManualScan: true,
  finishPhrases: [
    "A/B test won",
    "A/B test performed well for all",
    "A/B test inconclusive",
    "Test finished",
    "test completed",
    "performed well for all",
    "we updated your video",
    "similar performance",
    "not enough views",
    "not enough impressions",
    "not enough data",
    "not enough traffic",
    "no winner",
    "no clear",
    "inconclusive"
  ],
  ignorePhrases: [
    "A/B Test running",
    "Set a thumbnail that stands out",
    "made for kids",
    "COPPA",
    "age restriction",
    "personalized ads and notifications",
    "running... get suggestions",
    "running… get suggestions",
    "Video can't be monetized",
    "Claimed content found"
  ]
};

export function defaultExtensionRuntimeConfigJson() {
  return JSON.stringify(DEFAULT_EXTENSION_RUNTIME_CONFIG, null, 2);
}

export function parseExtensionRuntimeConfigJson(value) {
  if (!String(value || "").trim()) return normalizeExtensionRuntimeConfig({});
  try {
    return normalizeExtensionRuntimeConfig(JSON.parse(value));
  } catch (error) {
    const wrapped = new Error(`Extension runtime rules must be valid JSON: ${error.message}`);
    wrapped.status = 400;
    throw wrapped;
  }
}

export function safeParseExtensionRuntimeConfigJson(value) {
  try {
    return {
      config: parseExtensionRuntimeConfigJson(value),
      error: ""
    };
  } catch (error) {
    return {
      config: normalizeExtensionRuntimeConfig({}),
      error: error.message || "Extension runtime rules could not be parsed."
    };
  }
}

export function normalizeExtensionRuntimeConfig(input = {}) {
  const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    version: stringValue(safe.version, DEFAULT_EXTENSION_RUNTIME_CONFIG.version).slice(0, 60),
    minTextLength: clampNumber(safe.minTextLength, 8, 120, DEFAULT_EXTENSION_RUNTIME_CONFIG.minTextLength),
    maxTextLength: clampNumber(safe.maxTextLength, 140, 2000, DEFAULT_EXTENSION_RUNTIME_CONFIG.maxTextLength),
    maxEvents: clampNumber(safe.maxEvents, 5, 120, DEFAULT_EXTENSION_RUNTIME_CONFIG.maxEvents),
    waitAfterOpenMs: clampNumber(safe.waitAfterOpenMs, 300, 6000, DEFAULT_EXTENSION_RUNTIME_CONFIG.waitAfterOpenMs),
    waitForRowsMs: clampNumber(safe.waitForRowsMs, 1000, 12000, DEFAULT_EXTENSION_RUNTIME_CONFIG.waitForRowsMs),
    scrollRounds: clampNumber(safe.scrollRounds, 0, 8, DEFAULT_EXTENSION_RUNTIME_CONFIG.scrollRounds),
    scrollDelayMs: clampNumber(safe.scrollDelayMs, 150, 3000, DEFAULT_EXTENSION_RUNTIME_CONFIG.scrollDelayMs),
    scanOrder: safe.scanOrder === "studio_first" ? "studio_first" : "youtube_first",
    openYoutubeFallback: safe.openYoutubeFallback === true,
    includeSeenOnManualScan: safe.includeSeenOnManualScan !== false,
    finishPhrases: mergePhraseList(DEFAULT_EXTENSION_RUNTIME_CONFIG.finishPhrases, safe.finishPhrases, 48),
    ignorePhrases: mergePhraseList(DEFAULT_EXTENSION_RUNTIME_CONFIG.ignorePhrases, safe.ignorePhrases, 80)
  };
}

function mergePhraseList(required, custom, maxItems) {
  const values = [...required, ...(Array.isArray(custom) ? custom : [])]
    .map((item) => stringValue(item, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 120);
  return Array.from(new Set(values)).slice(0, maxItems);
}

function stringValue(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
