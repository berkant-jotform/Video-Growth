const MIN_TEXT_LENGTH = 18;
const MAX_TEXT_LENGTH = 700;
globalThis.__youtubeAbTestsConnectorLoaded = true;
globalThis.__youtubeAbTestsConnectorVersion = "0.1.14";
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
  if (message?.type === "studio-tab-status") {
    sendResponse(studioTabStatus());
    return false;
  }
  if (message?.type !== "scrape-studio-notifications") return false;
  scrapeStudioNotifications({ includeSeen: true })
    .then(async ({ events, diagnostics }) => {
      const response = await sendEvents(events);
      sendResponse({
        ...response,
        diagnostics,
        candidates: events.length,
        previews: events.slice(0, 5).map((event) => ({
          title: event.videoTitle || "",
          videoId: event.videoId || "",
          text: event.rawText || ""
        }))
      });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
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
  const candidates = queryAllDeep(NOTIFICATION_SELECTORS.join(","));

  const events = collectStudioPageStatusEvents(channel);
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const rawText = collapseText(element.innerText || element.textContent || "");
    const snippets = finishNotificationSnippets(rawText);
    if (!snippets.length && !isRelevant(rawText)) continue;
    const link = element.closest("a[href]") || element.querySelector?.("a[href]");
    const url = link?.href || findStudioVideoUrl(element) || location.href;
    const texts = snippets.length ? snippets : [rawText];
    for (const text of texts) {
      const event = {
        rawText: text,
        url,
        videoId: extractVideoId(`${url} ${text}`),
        channel,
        videoTitle: extractNotificationVideoTitle(text),
        observedAt: new Date().toISOString()
      };
      if (!rememberEvent(event, includeSeen)) continue;
      events.push(event);
      if (events.length >= 20) break;
    }
    if (events.length >= 20) break;
  }
  const bodySnippets = finishNotificationSnippets(document.body?.innerText || "");
  for (const text of bodySnippets) {
    const event = {
      rawText: text,
      url: findStudioVideoUrl(document.body) || location.href,
      videoId: extractVideoId(`${location.href} ${text}`),
      channel,
      videoTitle: extractNotificationVideoTitle(text),
      observedAt: new Date().toISOString()
    };
    if (!rememberEvent(event, includeSeen)) continue;
    events.push(event);
    if (events.length >= 20) break;
  }
  return compactEvents(events);
}

async function scrapeStudioNotifications({ includeSeen = false } = {}) {
  const before = collectNotificationEvents({ includeSeen });
  const opened = await openNotificationMenu();
  if (!opened) {
    const events = compactEvents(before);
    return {
      events,
      diagnostics: scanDiagnostics({
        menuOpened: false,
        before,
        after: [],
        events
      })
    };
  }
  await delay(1200);
  const after = collectNotificationEvents({ includeSeen });
  const events = compactEvents([...before, ...after]);
  return {
    events,
    diagnostics: scanDiagnostics({
      menuOpened: true,
      before,
      after,
      events
    })
  };
}

function scanDiagnostics({ menuOpened, before, after, events }) {
  const bodyText = document.body?.innerText || "";
  return {
    url: location.href,
    channel: detectChannelName(),
    menuOpened,
    notificationButtonFound: Boolean(findNotificationButton()),
    visibleNotificationContainers: queryAllDeep(NOTIFICATION_SELECTORS.join(",")).filter(isVisible).length,
    bodySnippetCount: finishNotificationSnippets(bodyText).length,
    bodyTextLength: bodyText.length,
    beforeCount: before.length,
    afterCount: after.length,
    eventCount: events.length,
    checkedAt: new Date().toISOString()
  };
}

function studioTabStatus() {
  return {
    url: location.href,
    channel: detectChannelName(),
    notificationButtonFound: Boolean(findNotificationButton()),
    visibleNotificationContainers: queryAllDeep(NOTIFICATION_SELECTORS.join(",")).filter(isVisible).length,
    bodySnippetCount: finishNotificationSnippets(document.body?.innerText || "").length,
    checkedAt: new Date().toISOString()
  };
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

function finishNotificationSnippets(rawText) {
  const text = collapseLongText(rawText);
  if (!text) return [];
  const matches = [];
  const patterns = [
    /A\/B test won .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /A\/B test performed well for all .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /A\/B test inconclusive .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /(?:Title|Thumbnail|A\/B)?\s*Test finished\.\s*Ran from .{8,220}? to .{8,220}?\./gi,
    /(?:test and compare|test & compare|thumbnail test|title test).{0,220}(?:finished|completed|ended|results? ready|no winner|similar performance)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const snippet = trimNotificationTail(match[0]);
      if (snippet && isRelevant(snippet)) matches.push(snippet);
    }
  }
  return Array.from(new Set(matches));
}

function extractNotificationVideoTitle(rawText) {
  const text = collapseText(rawText);
  const current = text.match(
    /\bA\/B test (?:won|performed well for all|inconclusive)\s+(.+?)(?::\s*(?:We updated your video to use the winner|Results with very similar performance|The test completed with no winner)\b|$)/i
  );
  if (current?.[1]) return current[1].trim();
  return "";
}

function trimNotificationTail(value) {
  return String(value || "")
    .replace(/\s+\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b.*$/i, "")
    .replace(/\s+(?:Today|Yesterday|This week)\b.*$/i, "")
    .trim();
}

function collapseText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function collapseLongText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16000);
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
    const element = queryOneDeep(selector);
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
  const html = deepOuterHtml(element).slice(0, 200000);
  const match = html.match(/https:\/\/studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}\/edit[^"'<\s]*/);
  return match ? match[0] : "";
}

async function openNotificationMenu() {
  const button = findNotificationButton();
  if (!button) return false;
  const expandedBefore = button.getAttribute("aria-expanded") === "true";
  if (!expandedBefore) {
    button.click();
  }
  await delay(250);
  return true;
}

function findNotificationButton() {
  const selectors = [
    "#notification-button",
    "ytcp-notification-button",
    "button[aria-label*='Notifications' i]",
    "tp-yt-paper-icon-button[aria-label*='Notifications' i]",
    "ytcp-icon-button[aria-label*='Notifications' i]",
    "[tooltip-label*='Notifications' i]",
    "button[aria-label*='notifications' i]",
    "yt-icon-button[aria-label*='Notifications' i]",
    "a[href*='/notifications']",
    "[aria-label*='Bildirim' i]"
  ];
  for (const selector of selectors) {
    const element = queryOneDeep(selector);
    const clickable = findClickable(element);
    if (clickable && isVisible(clickable)) return clickable;
  }
  const candidates = queryAllDeep("button, ytcp-icon-button, tp-yt-paper-icon-button");
  return (
    candidates.find((element) =>
      /notifications|bildirim/i.test(
        [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("tooltip-label"),
          element.textContent
        ]
          .filter(Boolean)
          .join(" ")
      )
    ) || null
  );
}

function findClickable(element) {
  if (!element) return null;
  if (typeof element.click === "function") return element;
  return queryOneDeep("button, ytcp-icon-button, tp-yt-paper-icon-button", element) || null;
}

function queryOneDeep(selector, root = document) {
  return queryAllDeep(selector, root)[0] || null;
}

function queryAllDeep(selector, root = document) {
  const results = [];
  const roots = [root];
  const seenRoots = new Set();
  for (let index = 0; index < roots.length; index += 1) {
    const scope = roots[index];
    if (!scope || seenRoots.has(scope)) continue;
    seenRoots.add(scope);
    if (scope.nodeType === Node.ELEMENT_NODE && scope.matches?.(selector)) results.push(scope);
    if (scope.shadowRoot) roots.push(scope.shadowRoot);
    for (const match of scope.querySelectorAll?.(selector) || []) results.push(match);
    const elements = scope.querySelectorAll?.("*") || [];
    for (const element of elements) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return Array.from(new Set(results));
}

function walkDeep(root) {
  const output = [];
  const stack = [root];
  const seenNodes = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seenNodes.has(node)) continue;
    seenNodes.add(node);
    output.push(node);
    const shadow = node.shadowRoot;
    if (shadow) stack.push(shadow);
    const children = node.children || node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return output;
}

function deepOuterHtml(root) {
  const parts = [];
  for (const node of walkDeep(root || document.body)) {
    if (node?.nodeType === Node.ELEMENT_NODE) {
      parts.push(node.outerHTML || node.textContent || "");
    }
  }
  return parts.join(" ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoId(value) {
  const match = String(value || "").match(
    /(?:youtu\.be\/|youtube\.com\/watch\?[^ ]*v=|youtube\.com\/shorts\/|studio\.youtube\.com\/video\/)([A-Za-z0-9_-]{6,})/
  );
  return match ? match[1] : "";
}
