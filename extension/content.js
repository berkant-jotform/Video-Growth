const MIN_TEXT_LENGTH = 18;
const MAX_TEXT_LENGTH = 700;
const NOTIFICATION_SELECTORS = [
  "ytcp-notification",
  "tp-yt-paper-toast",
  "ytd-notification-renderer",
  "ytcp-notifications-dialog",
  "ytcp-notification-menu",
  "[role='alert']",
  "[aria-live]"
];
const seen = new Set();
let currentUrl = location.href;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "scrape-studio-notifications") return false;
  const events = collectNotificationEvents({ includeSeen: true });
  sendEvents(events).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

schedulePageStatusScans();
window.setInterval(() => {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  schedulePageStatusScans();
}, 2000);

function collectNotificationEvents({ includeSeen = false } = {}) {
  const channel = detectChannelName();
  const candidates = [...document.querySelectorAll(NOTIFICATION_SELECTORS.join(","))];

  const events = collectStudioPageStatusEvents(channel);
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
    if (!rememberEvent(event, includeSeen)) continue;
    events.push(event);
    if (events.length >= 20) break;
  }
  return compactEvents(events);
}

function schedulePageStatusScans() {
  window.setTimeout(autoSendStudioPageStatus, 2500);
  window.setTimeout(autoSendStudioPageStatus, 8000);
}

async function autoSendStudioPageStatus() {
  const events = collectStudioPageStatusEvents(detectChannelName()).filter((event) =>
    rememberEvent(event, false)
  );
  if (!events.length) return;
  await sendEvents(compactEvents(events)).catch(() => {});
}

function collectStudioPageStatusEvents(channel) {
  const videoId = extractVideoId(location.href);
  if (!videoId || !/\/video\/[A-Za-z0-9_-]{6,}\/edit/i.test(location.href)) return [];
  const rawText = findTestFinishedSnippet(document.body?.innerText || "");
  if (!rawText || !isRelevant(rawText)) return [];
  return [
    {
      source: "studio_page_status",
      rawText,
      url: location.href,
      videoId,
      channel,
      observedAt: new Date().toISOString()
    }
  ];
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

function rememberEvent(event, includeSeen) {
  const key = `${event.videoId}|${event.rawText}|${event.url}`;
  if (!includeSeen && seen.has(key)) return false;
  seen.add(key);
  return true;
}

function isRelevant(text) {
  if (!text || text.length < MIN_TEXT_LENGTH) return false;
  if (text.length > MAX_TEXT_LENGTH) return false;
  if (
    /set a thumbnail that stands out|made for kids|coppa|age restriction|personalized ads and notifications|description i tested|running… get suggestions/i.test(
      text
    )
  ) {
    return false;
  }
  if (/^(?:a\/b|ab|thumbnail|title)?\s*test\s+(?:completed|ready)(?:\s+set\s+test)?$/i.test(text)) {
    return false;
  }
  if (/^test finished\.\s*ran from .{8,180}? to .{8,180}?\.$/i.test(text)) {
    return true;
  }
  if (/\ba\/b\s+test\s+(?:won|performed well for all|inconclusive)\b/i.test(text)) {
    return true;
  }
  if (/\bwe updated your video to use the winner\b/i.test(text)) {
    return true;
  }
  if (/\bresults? with very similar performance\b/i.test(text)) {
    return true;
  }
  if (/\btest completed with no winner\b/i.test(text)) {
    return true;
  }
  if (/\brunning\b/i.test(text) && !/\b(finished|complete|completed|ended|result|results|winner|won|selected|ready|not enough|no clear)\b/i.test(text)) {
    return false;
  }
  if (/not enough (?:impressions|data|traffic)|no clear|inconclusive/i.test(text)) return true;
  const hasTestContext = /\b(test and compare|test & compare|a\/b|ab test|experiment|thumbnail test|title test)\b/i.test(text);
  const hasFinishContext = /\b(finished|complete|completed|ended|result|results|winner|won|selected|ready)\b/i.test(text);
  return hasTestContext && hasFinishContext;
}

function collapseText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function findTestFinishedSnippet(value) {
  const text = collapseText(value);
  const exact = text.match(/(?:Title|Thumbnail|A\/B)?\s*Test finished\.\s*Ran from .{8,180}? to .{8,180}?\./i);
  if (exact?.[0]) return collapseText(exact[0]);
  const fallback = text.match(/(?:test and compare|test & compare|a\/b|thumbnail test|title test).{0,220}(?:finished|completed|ended|results? ready|won|performed well for all|inconclusive|no winner|similar performance)/i);
  return fallback?.[0] ? collapseText(fallback[0]) : "";
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
