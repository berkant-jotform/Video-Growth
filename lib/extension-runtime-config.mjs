export const EXTENSION_RUNTIME_CONFIG_KEY = "EXTENSION_RUNTIME_CONFIG_JSON";

export const DEFAULT_EXTENSION_RUNTIME_CONFIG = {
  version: "2026-07-10.1",
  minTextLength: 18,
  maxTextLength: 700,
  maxEvents: 60,
  waitAfterOpenMs: 1200,
  waitForRowsMs: 4500,
  scrollRounds: 3,
  scrollDelayMs: 650,
  scanOrder: "youtube_first",
  openYoutubeFallback: true,
  deepScanFallbackEnabled: false,
  includeSeenOnManualScan: true,
  notificationSelectors: [
    "ytcp-notification",
    "ytcp-notification-item",
    "ytd-notification-renderer",
    "ytd-multi-page-menu-renderer",
    "ytd-popup-container",
    "tp-yt-iron-dropdown",
    "ytcp-notifications-dialog",
    "ytcp-notification-menu",
    "[role='alert']",
    "[aria-live]"
  ],
  notificationButtonSelectors: [
    "#notification-button",
    "ytcp-notification-button",
    "ytcp-notifications-button button",
    "ytcp-notifications-button tp-yt-paper-icon-button",
    "ytd-notification-topbar-button-renderer button",
    "ytd-notification-topbar-button-renderer #button",
    "button[aria-label*='Notification' i]",
    "tp-yt-paper-icon-button[aria-label*='Notifications' i]",
    "ytcp-icon-button[aria-label*='Notifications' i]",
    "[tooltip-label*='Notifications' i]",
    "[aria-label*='Bildirim' i]"
  ],
  notificationSurfaceSelectors: [
    "ytd-multi-page-menu-renderer",
    "ytd-notification-renderer",
    "tp-yt-iron-dropdown",
    "ytcp-notifications-dialog",
    "ytcp-notification-menu"
  ],
  finishPhrases: [
    "A/B test won",
    "A/B test performed well for all",
    "A/B test inconclusive",
    "Test finished",
    "test completed",
    "performed well for all",
    "we updated your video",
    "updated your video to use the winner",
    "The test completed with no winner",
    "similar performance",
    "Results with very similar performance",
    "Not enough views to determine a winner",
    "not enough views",
    "not enough impressions",
    "not enough data",
    "not enough traffic",
    "could not determine a winner",
    "couldn't determine a winner",
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
    "Video can’t be monetized",
    "Claimed content found",
    "claimed content",
    "tap to resolve"
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
    openYoutubeFallback: safe.openYoutubeFallback !== false,
    deepScanFallbackEnabled: safe.deepScanFallbackEnabled === true,
    includeSeenOnManualScan: safe.includeSeenOnManualScan !== false,
    notificationSelectors: mergeSelectorList(
      DEFAULT_EXTENSION_RUNTIME_CONFIG.notificationSelectors,
      safe.notificationSelectors,
      48
    ),
    notificationButtonSelectors: mergeSelectorList(
      DEFAULT_EXTENSION_RUNTIME_CONFIG.notificationButtonSelectors,
      safe.notificationButtonSelectors,
      48
    ),
    notificationSurfaceSelectors: mergeSelectorList(
      DEFAULT_EXTENSION_RUNTIME_CONFIG.notificationSurfaceSelectors,
      safe.notificationSurfaceSelectors,
      32
    ),
    finishPhrases: mergePhraseList(DEFAULT_EXTENSION_RUNTIME_CONFIG.finishPhrases, safe.finishPhrases, 48),
    ignorePhrases: mergePhraseList(DEFAULT_EXTENSION_RUNTIME_CONFIG.ignorePhrases, safe.ignorePhrases, 80)
  };
}

function mergeSelectorList(required, custom, maxItems) {
  const values = [...required, ...(Array.isArray(custom) ? custom : [])]
    .map((item) => stringValue(item, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 180)
    .filter(isSafeSelector);
  return Array.from(new Set(values)).slice(0, maxItems);
}

function isSafeSelector(value) {
  if (/[{};<>]/.test(value)) return false;
  try {
    // Browser content scripts validate selectors again before querying.
    return !value.includes(":has(");
  } catch {
    return false;
  }
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
