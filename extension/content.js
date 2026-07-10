const MIN_TEXT_LENGTH = 18;
const MAX_TEXT_LENGTH = 700;
const MAX_EVENTS = 60;
globalThis.__youtubeAbTestsConnectorLoaded = true;
globalThis.__youtubeAbTestsConnectorVersion = "0.3.1";
const DEFAULT_RUNTIME_CONFIG = {
  minTextLength: MIN_TEXT_LENGTH,
  maxTextLength: MAX_TEXT_LENGTH,
  maxEvents: MAX_EVENTS,
  waitAfterOpenMs: 1200,
  waitForRowsMs: 4500,
  scrollRounds: 3,
  scrollDelayMs: 650,
  includeSeenOnManualScan: true,
  notificationSelectors: [],
  notificationButtonSelectors: [],
  notificationSurfaceSelectors: [],
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
const FINISH_TEXT_HINT = /\b(a\/b\s+test|test\s+finished|test\s+completed|performed\s+well\s+for\s+all|we\s+updated\s+your\s+video|similar\s+performance|not\s+enough\s+(?:views|impressions|data|traffic)|no\s+winner|inconclusive)\b/i;
const NOTIFICATION_SELECTORS = [
  "ytcp-notification",
  "ytcp-notification *",
  "ytcp-notification-item",
  "ytcp-notification-item *",
  "tp-yt-paper-toast",
  "ytd-notification-renderer",
  "ytd-notification-renderer *",
  "ytd-multi-page-menu-renderer",
  "ytd-multi-page-menu-renderer *",
  "ytd-popup-container",
  "tp-yt-iron-dropdown",
  "ytcp-notifications-dialog",
  "ytcp-notifications-dialog *",
  "ytcp-notification-menu",
  "ytcp-notification-menu *",
  "[role='alert']",
  "[aria-live]"
];
const NOTIFICATION_BUTTON_SELECTORS = [
  "#notification-button",
  "ytcp-notification-button",
  "ytcp-notifications-button",
  "ytcp-notifications-button button",
  "ytcp-notifications-button tp-yt-paper-icon-button",
  "ytd-notification-topbar-button-renderer",
  "ytd-notification-topbar-button-renderer button",
  "ytd-notification-topbar-button-renderer #button",
  "button[aria-label*='Notification' i]",
  "button[aria-label*='Notifications' i]",
  "tp-yt-paper-icon-button[aria-label*='Notifications' i]",
  "ytcp-icon-button[aria-label*='Notifications' i]",
  "[tooltip-label*='Notifications' i]",
  "[aria-label*='Bildirim' i]"
];
const NOTIFICATION_SURFACE_SELECTORS = [
  "ytd-multi-page-menu-renderer",
  "ytd-notification-renderer",
  "tp-yt-iron-dropdown",
  "ytcp-notifications-dialog",
  "ytcp-notification-menu"
];
const seen = new Set();
let currentUrl = location.href;
let lastNotificationOpenResult = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "studio-tab-status") {
    sendResponse(studioTabStatus());
    return false;
  }
  if (message?.type !== "scrape-studio-notifications") return false;
  const runtimeConfig = normalizeRuntimeConfig(message.runtimeConfig);
  scrapeStudioNotifications({
    includeSeen: Boolean(message.forcePost && runtimeConfig.includeSeenOnManualScan),
    runtimeConfig
  })
    .then(async ({ events, diagnostics }) => {
      const response = await sendEvents(events, {
        forcePost: Boolean(message.forcePost),
        channelScope: message.channelScope || [],
        testTypeScope: message.testTypeScope || "all"
      });
      sendResponse({
        ...response,
        diagnostics: { ...diagnostics, runtimeConfigVersion: runtimeConfig.version || "" },
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

function collectNotificationEvents({ includeSeen = false, runtimeConfig = DEFAULT_RUNTIME_CONFIG } = {}) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const channel = detectChannelName();
  const channelId = detectChannelId();
  const candidates = queryAllDeep(selectorList(config.notificationSelectors, NOTIFICATION_SELECTORS).join(","));
  const pageText = currentPageText();

  const events = collectStudioPageStatusEvents(channel);
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const rawText = collapseText(element.innerText || element.textContent || "");
    const snippets = finishNotificationSnippets(rawText, config);
    if (!snippets.length && !isRelevant(rawText, config)) continue;
    const link = element.closest("a[href]") || element.querySelector?.("a[href]");
    const linkedUrl = link?.href || findStudioVideoUrl(element);
    const url = linkedUrl || location.href;
    const texts = snippets.length ? snippets : [rawText];
    for (const text of texts) {
      const event = {
        rawText: text,
        url,
        videoId: extractVideoId(`${linkedUrl || ""} ${text}`),
        channel,
        channelId,
        videoTitle: extractNotificationVideoTitle(text),
        notificationAge: extractAgeAfterSnippet(`${rawText} ${pageText}`, text),
        observedAt: new Date().toISOString()
      };
      if (!rememberEvent(event, includeSeen)) continue;
      events.push(event);
      if (events.length >= config.maxEvents) break;
    }
    if (events.length >= config.maxEvents) break;
  }
  const bodySnippets = finishNotificationSnippets(pageText, config);
  for (const text of bodySnippets) {
    const event = {
      rawText: text,
      url: location.href,
      videoId: extractVideoId(text),
      channel,
      channelId,
      videoTitle: extractNotificationVideoTitle(text),
      notificationAge: extractAgeAfterSnippet(pageText, text),
      observedAt: new Date().toISOString()
    };
    if (!rememberEvent(event, includeSeen)) continue;
    events.push(event);
    if (events.length >= config.maxEvents) break;
  }
  for (const text of rawFinishTextWindows(pageText, config)) {
    const event = {
      source: "visible_text_block",
      rawText: text,
      url: location.href,
      videoId: extractVideoId(text),
      channel,
      channelId,
      videoTitle: extractNotificationVideoTitle(text),
      notificationAge: extractAgeAfterSnippet(pageText, text),
      observedAt: new Date().toISOString()
    };
    if (!rememberEvent(event, includeSeen)) continue;
    events.push(event);
    if (events.length >= config.maxEvents) break;
  }
  return compactEvents(events);
}

async function scrapeStudioNotifications({ includeSeen = false, runtimeConfig = DEFAULT_RUNTIME_CONFIG } = {}) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const before = collectNotificationEvents({ includeSeen, runtimeConfig: config });
  const opened = await openNotificationMenu(config);
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
  await delay(config.waitAfterOpenMs);
  const after = await waitForNotificationEvents({ includeSeen, timeoutMs: config.waitForRowsMs, runtimeConfig: config });
  const { scrolls, events: scrolledEvents } = await collectWithScrolling({ includeSeen, runtimeConfig: config });
  const events = compactEvents([...before, ...after, ...scrolledEvents]);
  return {
    events,
    diagnostics: scanDiagnostics({
      menuOpened: true,
      before,
      after: [...after, ...scrolledEvents],
      events
    }, { scrolls, runtimeConfig: config })
  };
}

function scanDiagnostics({ menuOpened, before, after, events }, extra = {}) {
  const config = normalizeRuntimeConfig(extra.runtimeConfig);
  const bodyText = currentPageText();
  const rawWindows = rawFinishTextWindows(bodyText, config);
  const bodySnippets = finishNotificationSnippets(bodyText, config);
  return {
    url: location.href,
    channel: detectChannelName(),
    channelId: detectChannelId(),
    menuOpened,
    notificationButtonFound: Boolean(findNotificationButton(config)),
    pageIdentity: detectPageIdentity(),
    visibleNotificationContainers: queryAllDeep(selectorList(config.notificationSelectors, NOTIFICATION_SELECTORS).join(",")).filter(isVisible).length,
    bodySnippetCount: bodySnippets.length,
    rawWindowCount: rawWindows.length,
    finishHintCount: countFinishHints(bodyText),
    debugSample: events.length ? "" : debugTextSample(bodyText, rawWindows),
    bodyTextLength: bodyText.length,
    beforeCount: before.length,
    afterCount: after.length,
    eventCount: events.length,
    notificationScrolls: Number(extra.scrolls || 0),
    runtimeConfigVersion: config.version || "",
    notificationOpenResult: lastNotificationOpenResult || null,
    checkedAt: new Date().toISOString()
  };
}

function studioTabStatus() {
  const config = normalizeRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  const bodyText = currentPageText();
  const rawWindows = rawFinishTextWindows(bodyText);
  return {
    url: location.href,
    channel: detectChannelName(),
    channelId: detectChannelId(),
    notificationButtonFound: Boolean(findNotificationButton(config)),
    pageIdentity: detectPageIdentity(),
    visibleNotificationContainers: queryAllDeep(selectorList(config.notificationSelectors, NOTIFICATION_SELECTORS).join(",")).filter(isVisible).length,
    bodySnippetCount: finishNotificationSnippets(bodyText).length,
    rawWindowCount: rawWindows.length,
    finishHintCount: countFinishHints(bodyText),
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
      channelId: detectChannelId(),
      observedAt: new Date().toISOString()
    }
  ];
}

async function sendEvents(events, options = {}) {
  if (!events.length) return { ok: true, received: 0 };
  return chrome.runtime.sendMessage({
    type: "studio-notifications",
    events,
    forcePost: Boolean(options.forcePost),
    channelScope: options.channelScope || [],
    testTypeScope: options.testTypeScope || "all"
  });
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

function isRelevant(text, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  if (!text || text.length < config.minTextLength) return false;
  if (text.length > config.maxTextLength) return false;
  const hasConfiguredFinishHint = FINISH_TEXT_HINT.test(text) || runtimePhraseMatch(text, config.finishPhrases);
  if (runtimePhraseMatch(text, config.ignorePhrases) && !hasConfiguredFinishHint) {
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
  if (/not enough (?:views|impressions|data|traffic)|no clear|inconclusive|could(?:\s+not|n't) determine/i.test(text)) return true;
  if (runtimePhraseMatch(text, config.finishPhrases)) return true;
  const hasTestContext = /\b(test and compare|test & compare|a\/b|ab test|experiment|thumbnail test|title test)\b/i.test(text);
  const hasFinishContext = /\b(finished|complete|completed|ended|result|results|winner|won|selected|ready)\b/i.test(text);
  return hasTestContext && hasFinishContext;
}

function finishNotificationSnippets(rawText, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const config = normalizeRuntimeConfig(runtimeConfig);
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
      if (snippet && isRelevant(snippet, config)) matches.push(snippet);
    }
  }
  return Array.from(new Set(matches));
}

function rawFinishTextWindows(rawText, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const text = collapseLongText(rawText);
  if (!text || (!FINISH_TEXT_HINT.test(text) && !runtimePhraseMatch(text, config.finishPhrases))) return [];
  const windows = [];
  const seenRanges = [];
  const pattern = new RegExp(FINISH_TEXT_HINT.source, "gi");
  for (const match of text.matchAll(pattern)) {
    const center = match.index || 0;
    const start = Math.max(0, center - 80);
    const end = Math.min(text.length, center + 900);
    if (seenRanges.some((range) => start >= range.start && end <= range.end)) continue;
    seenRanges.push({ start, end });
    const value = trimNotificationTail(text.slice(start, end).trim());
    if (value.length >= config.minTextLength && isRelevant(value, config)) windows.push(value);
    if (windows.length >= 12) break;
  }
  return Array.from(new Set(windows));
}

function countFinishHints(rawText) {
  const text = collapseLongText(rawText);
  if (!text) return 0;
  return Array.from(text.matchAll(new RegExp(FINISH_TEXT_HINT.source, "gi"))).length;
}

function debugTextSample(rawText, rawWindows = []) {
  const text = rawWindows[0] || collapseLongText(rawText).slice(0, 700);
  return redactDebugText(text);
}

function redactDebugText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:ya29|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]+/gi, "[token]")
    .slice(0, 700);
}

function extractNotificationVideoTitle(rawText) {
  const text = collapseText(rawText);
  const partial = text.match(
    /\bA\/B test (?:won|performed well for all|inconclusive)\s+(.+?)(?::\s*(?:We\b|Results?\b|The test\b|Not enough\b|No winner\b)|$)/i
  );
  if (partial?.[1]) return partial[1].trim();
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

function extractAgeAfterSnippet(rawText, snippet) {
  const source = collapseLongText(rawText);
  const target = collapseText(snippet);
  const index = source.indexOf(target);
  const tail = index >= 0 ? source.slice(index + target.length, index + target.length + 120) : source;
  const match = tail.match(/\b(\d+)\s+(minute|hour|day|week|month)s?\s+ago\b/i);
  if (!match) return { label: "", days: null };
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const days =
    unit === "minute" ? 0 :
      unit === "hour" ? 0 :
        unit === "day" ? amount :
          unit === "week" ? amount * 7 :
            unit === "month" ? amount * 30 :
              null;
  return { label: match[0], days };
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

function currentPageText() {
  const deepText = deepVisibleFinishText();
  const bodyText = String(document.body?.innerText || "").slice(0, 12000);
  // Notification menus often live late in YouTube's shadow DOM. Put their
  // focused text first so the global length cap cannot discard finish rows.
  return collapseLongText([deepText, bodyText].filter(Boolean).join(" "));
}

function deepVisibleFinishText() {
  const chunks = [];
  const seenText = new Set();
  let length = 0;
  for (const node of walkDeep(document.body || document.documentElement)) {
    if (node?.nodeType !== Node.ELEMENT_NODE) continue;
    if (!isVisible(node)) continue;
    const rawText = node.innerText || node.textContent || "";
    if (!FINISH_TEXT_HINT.test(rawText)) continue;
    const text = collapseText(rawText);
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    chunks.push(text);
    length += text.length;
    if (length > 30000) break;
  }
  return collapseLongText(chunks.join(" "));
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

function detectChannelId() {
  const urlMatch = location.href.match(/\/channel\/(UC[A-Za-z0-9_-]{10,})/i);
  if (urlMatch?.[1]) return urlMatch[1];
  const direct = queryOneDeep(
    "[data-channel-id*='UC'], [channel-id*='UC'], a[href*='/channel/UC'], meta[content*='UC']"
  );
  const directText = [
    direct?.getAttribute?.("data-channel-id"),
    direct?.getAttribute?.("channel-id"),
    direct?.getAttribute?.("href"),
    direct?.getAttribute?.("content")
  ].filter(Boolean).join(" ");
  const directMatch = directText.match(/(UC[A-Za-z0-9_-]{10,})/i);
  if (directMatch?.[1]) return directMatch[1];
  return findDeepChannelId(document.body || document.documentElement);
}

function cleanChannelLabel(value) {
  return String(value || "")
    .replace(/^Account menu[:\s]*/i, "")
    .replace(/^Current account[:\s]*/i, "")
    .replace(/\s+-\s+YouTube Studio.*$/i, "")
    .trim();
}

function findStudioVideoUrl(element) {
  const link = queryOneDeep("a[href*='studio.youtube.com/video/']", element);
  const href = link?.href || link?.getAttribute?.("href") || "";
  const match = href.match(/https:\/\/studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}\/edit[^"'<\s]*/);
  return match?.[0] || "";
}

async function openNotificationMenu(runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const button = findNotificationButton(config);
  lastNotificationOpenResult = {
    foundButton: Boolean(button),
    buttonLabel: button ? notificationButtonLabel(button) : "",
    opened: false,
    attempts: 0,
    surfaceVisible: notificationSurfaceVisible(config)
  };
  if (!button) return false;
  if (lastNotificationOpenResult.surfaceVisible) {
    lastNotificationOpenResult.opened = true;
    return true;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastNotificationOpenResult.attempts = attempt + 1;
    const expanded = button.getAttribute("aria-expanded") === "true";
    if (!expanded || attempt > 0) {
      clickLikeUser(button);
    }
    await delay(500 + attempt * 300);
    lastNotificationOpenResult.surfaceVisible = notificationSurfaceVisible(config);
    if (lastNotificationOpenResult.surfaceVisible || finishNotificationSnippets(currentPageText()).length) {
      lastNotificationOpenResult.opened = true;
      return true;
    }
  }
  lastNotificationOpenResult.surfaceVisible = notificationSurfaceVisible(config);
  lastNotificationOpenResult.opened = lastNotificationOpenResult.surfaceVisible;
  return lastNotificationOpenResult.opened;
}

function findNotificationButton(runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const selectors = selectorList(runtimeConfig.notificationButtonSelectors, NOTIFICATION_BUTTON_SELECTORS);
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

async function waitForNotificationEvents({ includeSeen, timeoutMs = 4000, runtimeConfig = DEFAULT_RUNTIME_CONFIG } = {}) {
  const startedAt = Date.now();
  const config = normalizeRuntimeConfig(runtimeConfig);
  let latest = collectNotificationEvents({ includeSeen, runtimeConfig: config });
  while (!latest.length && Date.now() - startedAt < timeoutMs) {
    await delay(500);
    latest = collectNotificationEvents({ includeSeen, runtimeConfig: config });
  }
  return latest;
}

async function collectWithScrolling({ includeSeen, runtimeConfig = DEFAULT_RUNTIME_CONFIG } = {}) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const events = [];
  let scrolls = 0;
  for (let round = 0; round < config.scrollRounds; round += 1) {
    scrolls += await scrollNotificationSurfaces(round, config);
    await delay(config.scrollDelayMs);
    events.push(...collectNotificationEvents({ includeSeen, runtimeConfig: config }));
  }
  return { scrolls, events: compactEvents(events) };
}

async function scrollNotificationSurfaces(round = 0, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const surfaces = queryAllDeep(
    selectorList(runtimeConfig.notificationSurfaceSelectors, NOTIFICATION_SURFACE_SELECTORS).join(",")
  ).filter(isVisible);
  const containers = new Set();
  for (const surface of surfaces) {
    for (const candidate of [surface, surface.parentElement, surface.parentElement?.parentElement]) {
      if (!candidate) continue;
      if (candidate.scrollHeight > candidate.clientHeight + 20) containers.add(candidate);
    }
  }
  let count = 0;
  for (const container of containers) {
    const targets = round % 2 === 0
      ? [container.scrollHeight, Math.floor(container.scrollHeight * 0.55)]
      : [0, container.scrollHeight];
    for (const target of targets) {
      container.scrollTop = target;
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      count += 1;
    }
  }
  return count;
}

function findClickable(element) {
  if (!element) return null;
  const inner = queryOneDeep(
    "button, #button, [role='button'], ytcp-icon-button, tp-yt-paper-icon-button, yt-icon-button",
    element
  );
  if (inner && inner !== element && isVisible(inner)) return inner;
  if (element.matches?.("button, [role='button'], ytcp-icon-button, tp-yt-paper-icon-button, yt-icon-button")) {
    return element;
  }
  return inner || null;
}

function notificationSurfaceVisible(runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  return queryAllDeep(
    selectorList(runtimeConfig.notificationSurfaceSelectors, NOTIFICATION_SURFACE_SELECTORS).join(",")
  ).some(isVisible);
}

function clickLikeUser(element) {
  try {
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.focus?.();
  } catch {}
  const mouseOptions = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerdown", { ...mouseOptions, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent("mousedown", mouseOptions));
  element.dispatchEvent(new MouseEvent("mouseup", mouseOptions));
  element.click?.();
}

function notificationButtonLabel(element) {
  if (!element) return "";
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("tooltip-label"),
    element.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function detectPageIdentity() {
  const text = collapseText(document.body?.innerText || "").slice(0, 5000);
  const accountLabels = queryAllDeep("[aria-label], [title]")
    .map((element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "))
    .filter((value) => /account|hesap|channel|kanal|jotform|ai agents/i.test(value))
    .slice(0, 8);
  return {
    title: document.title || "",
    url: location.href,
    accountHints: accountLabels.map((value) => collapseText(value).slice(0, 140)),
    hasStudioText: /youtube studio|dashboard|content|analytics/i.test(text),
    hasYoutubeNotificationsText: /notifications|bildirimler|a\/b test/i.test(text)
  };
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

function findDeepChannelId(root) {
  let checked = 0;
  for (const node of walkDeep(root)) {
    if (node?.nodeType !== Node.ELEMENT_NODE) continue;
    checked += 1;
    if (checked > 5000) break;
    const values = [
      node.getAttribute?.("data-channel-id"),
      node.getAttribute?.("channel-id"),
      node.getAttribute?.("browse-id"),
      node.getAttribute?.("href"),
      node.getAttribute?.("content")
    ].filter(Boolean).join(" ");
    const match = values.match(/(UC[A-Za-z0-9_-]{10,})/i);
    if (match?.[1]) return match[1];
  }
  return "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRuntimeConfig(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...input,
    minTextLength: clampNumber(input.minTextLength, 8, 120, DEFAULT_RUNTIME_CONFIG.minTextLength),
    maxTextLength: clampNumber(input.maxTextLength, 140, 2000, DEFAULT_RUNTIME_CONFIG.maxTextLength),
    maxEvents: clampNumber(input.maxEvents, 5, 120, DEFAULT_RUNTIME_CONFIG.maxEvents),
    waitAfterOpenMs: clampNumber(input.waitAfterOpenMs, 300, 6000, DEFAULT_RUNTIME_CONFIG.waitAfterOpenMs),
    waitForRowsMs: clampNumber(input.waitForRowsMs, 1000, 12000, DEFAULT_RUNTIME_CONFIG.waitForRowsMs),
    scrollRounds: clampNumber(input.scrollRounds, 0, 8, DEFAULT_RUNTIME_CONFIG.scrollRounds),
    scrollDelayMs: clampNumber(input.scrollDelayMs, 150, 3000, DEFAULT_RUNTIME_CONFIG.scrollDelayMs),
    includeSeenOnManualScan: input.includeSeenOnManualScan !== false,
    notificationSelectors: mergeSelectorList(input.notificationSelectors, 48),
    notificationButtonSelectors: mergeSelectorList(input.notificationButtonSelectors, 48),
    notificationSurfaceSelectors: mergeSelectorList(input.notificationSurfaceSelectors, 32),
    finishPhrases: mergeRuntimePhrases(DEFAULT_RUNTIME_CONFIG.finishPhrases, input.finishPhrases, 80),
    ignorePhrases: mergeRuntimePhrases(DEFAULT_RUNTIME_CONFIG.ignorePhrases, input.ignorePhrases, 100)
  };
}

function mergeSelectorList(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= 2 && item.length <= 180)
    .filter((item) => !/[{};<>]/.test(item))))
    .slice(0, maxItems);
}

function selectorList(configured, fallback) {
  const candidates = Array.isArray(configured) && configured.length ? configured : fallback;
  return candidates.filter((selector) => {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch {
      return false;
    }
  });
}

function mergeRuntimePhrases(required, custom, maxItems) {
  const values = [
    ...(Array.isArray(required) ? required : []),
    ...(Array.isArray(custom) ? custom : [])
  ]
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= 2 && item.length <= 140);
  return Array.from(new Set(values)).slice(0, maxItems);
}

function runtimePhraseMatch(text, phrases = []) {
  const source = String(text || "").toLowerCase();
  return phrases.some((phrase) => {
    const value = String(phrase || "").trim().toLowerCase();
    return value.length >= 2 && source.includes(value);
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function extractVideoId(value) {
  const match = String(value || "").match(
    /(?:youtu\.be\/|youtube\.com\/watch\?[^ ]*v=|youtube\.com\/shorts\/|studio\.youtube\.com\/video\/)([A-Za-z0-9_-]{6,})/
  );
  return match ? match[1] : "";
}
