const FINISH_RE =
  /(test|compare|a\/b|thumbnail|title|experiment|winner|finished|complete|completed|ended|result|not enough impressions|no clear)/i;
const MIN_TEXT_LENGTH = 18;
const SCAN_DEBOUNCE_MS = 8000;
const seen = new Set();
let scanTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "scrape-studio-notifications") return false;
  const events = collectNotificationEvents({ includeSeen: true });
  sendEvents(events).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

scheduleScan();

const observer = new MutationObserver(() => scheduleScan());
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

function scheduleScan() {
  if (scanTimer) return;
  scanTimer = window.setTimeout(async () => {
    scanTimer = null;
    const events = collectNotificationEvents();
    if (events.length) await sendEvents(events);
  }, SCAN_DEBOUNCE_MS);
}

function collectNotificationEvents({ includeSeen = false } = {}) {
  const channel = detectChannelName();
  const candidates = [
    ...document.querySelectorAll(
      [
        "ytcp-notification",
        "tp-yt-paper-toast",
        "ytd-notification-renderer",
        "[role='alert']",
        "[aria-live]",
        "a[href*='/video/']",
        "div",
        "span"
      ].join(",")
    )
  ];

  const events = [];
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const rawText = collapseText(element.innerText || element.textContent || "");
    if (!isRelevant(rawText)) continue;
    const link = element.closest("a[href]") || element.querySelector?.("a[href]");
    const url = link?.href || findStudioVideoUrl(element) || location.href;
    const event = {
      rawText,
      url,
      videoId: extractVideoId(`${url} ${rawText}`),
      channel,
      observedAt: new Date().toISOString()
    };
    const key = `${event.videoId}|${event.rawText}|${event.url}`;
    if (!includeSeen && seen.has(key)) continue;
    seen.add(key);
    events.push(event);
    if (events.length >= 20) break;
  }
  return compactEvents(events);
}

async function sendEvents(events) {
  if (!events.length) return { ok: true, received: 0 };
  return chrome.runtime.sendMessage({ type: "studio-notifications", events });
}

function compactEvents(events) {
  const map = new Map();
  for (const event of events) {
    const key = `${event.videoId}|${event.rawText.slice(0, 160)}`;
    if (!map.has(key)) map.set(key, event);
  }
  return Array.from(map.values());
}

function isRelevant(text) {
  if (!text || text.length < MIN_TEXT_LENGTH) return false;
  if (!FINISH_RE.test(text)) return false;
  return /(test|compare|a\/b|thumbnail|title|winner|finished|complete|completed|ended|result|not enough impressions|no clear)/i.test(text);
}

function collapseText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
}

function detectChannelName() {
  const selectors = [
    "#avatar-btn[aria-label]",
    "ytcp-account-menu #channel-title",
    "[data-channel-name]",
    "meta[itemprop='name']"
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value =
      element?.getAttribute("data-channel-name") ||
      element?.getAttribute("aria-label") ||
      element?.getAttribute("content") ||
      element?.textContent ||
      "";
    const cleaned = cleanChannelLabel(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanChannelLabel(value) {
  return String(value || "")
    .replace(/^Account menu[:\s]*/i, "")
    .replace(/^Current account[:\s]*/i, "")
    .replace(/\s+-\s+YouTube Studio.*$/i, "")
    .trim();
}

function findStudioVideoUrl(element) {
  const html = element.outerHTML || "";
  const match = html.match(/https:\/\/studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}\/edit[^"'<\s]*/);
  return match ? match[0] : "";
}

function extractVideoId(value) {
  const match = String(value || "").match(
    /(?:youtu\.be\/|youtube\.com\/watch\?[^ ]*v=|youtube\.com\/shorts\/|studio\.youtube\.com\/video\/)([A-Za-z0-9_-]{6,})/
  );
  return match ? match[1] : "";
}
