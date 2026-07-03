const EXTENSION_VERSION = "0.1.22";
const DEEP_SCAN_LIMIT = 8;
const NOTIFICATION_WATCHER_URL = "https://www.youtube.com/";
const APP_BRIDGE_MATCHES = ["https://*.vercel.app/*", "http://127.0.0.1:8770/*"];
const DEFAULT_SETTINGS = {
  appUrl: "https://video-growth.vercel.app",
  connectorToken: "",
  actorName: "",
  channels: "Jotform, AI Agents Podcast, AI Agents",
  connectorId: ""
};
let studioScrapePromise = null;
let watcherOpenPromise = null;

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (!settings.connectorId) {
    await chrome.storage.sync.set({ connectorId: crypto.randomUUID() });
  }
  scheduleHourlyAlarm();
  await injectAppBridgeIntoAppTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleHourlyAlarm();
  injectAppBridgeIntoAppTabs().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "youtube-ab-heartbeat") return;
  await sendHeartbeat().catch((error) => appendDiagnosticLog({
    category: "heartbeat",
    severity: "warning",
    message: "Scheduled heartbeat failed",
    context: { error: error.message }
  }));
  await requestStudioScrapeGuarded().catch((error) => appendDiagnosticLog({
    category: "extension_scan",
    severity: "warning",
    message: "Scheduled scan failed",
    context: { error: error.message }
  }));
  scheduleHourlyAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "studio-notifications") {
    postEvents(message.events || [], sender.tab?.url || "")
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "send-heartbeat") {
    sendHeartbeat()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "scan-studio-tab") {
    requestStudioScrapeGuarded()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "open-notification-page") {
    openNotificationPage()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "report-missed-notification") {
    reportMissedNotification()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "deep-scan-active-videos") {
    deepScanActiveVideos()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "open-watcher-tabs") {
    openWatcherTabsGuarded(message.targets || [], { onlyMissing: message.onlyMissing !== false })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "smart-start-watching") {
    openWatcherTabsGuarded([], { onlyMissing: true, runScan: true })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "get-connector-config") {
    getSettings()
      .then((settings) => {
        requireConfigured(settings);
        return fetchConnectorConfig(settings);
      })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "inject-app-bridge") {
    injectAppBridgeIntoAppTabs()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

function scheduleHourlyAlarm() {
  chrome.alarms.create("youtube-ab-heartbeat", {
    delayInMinutes: minutesUntilNextHour(),
    periodInMinutes: 60
  });
}

function requestStudioScrapeGuarded() {
  if (studioScrapePromise) return studioScrapePromise;
  studioScrapePromise = requestStudioScrape().finally(() => {
    studioScrapePromise = null;
  });
  return studioScrapePromise;
}

function openWatcherTabsGuarded(requestedTargets = [], options = {}) {
  if (watcherOpenPromise) return watcherOpenPromise;
  watcherOpenPromise = openWatcherTabs(requestedTargets, options).finally(() => {
    watcherOpenPromise = null;
  });
  return watcherOpenPromise;
}

async function requestStudioScrape() {
  const tabs = await collectScrapeTabs();
  const results = [];
  for (const tab of tabs) {
    try {
      await ensureContentScript(tab.id);
      const response = await chrome.tabs.sendMessage(tab.id, { type: "scrape-studio-notifications" });
      results.push({ tabId: tab.id, tabTitle: tab.title || "", tabUrl: tab.url || "", ...response });
    } catch (error) {
      results.push({ tabId: tab.id, tabTitle: tab.title || "", tabUrl: tab.url || "", ok: false, error: error.message });
    }
  }
  await chrome.storage.local.set({
    lastStudioScanAt: new Date().toISOString(),
    lastStudioScanResult: {
      tabs: results.map(summarizeTabScanResult),
      totals: summarizeScanResults(results),
      diagnosis: buildScanDiagnosis(results)
    }
  });
  await appendDiagnosticLog({
    category: "extension_scan",
    severity: buildScanDiagnosis(results).severity || "info",
    message: buildScanDiagnosis(results).message || "Extension scan completed",
    context: {
      totals: summarizeScanResults(results),
      tabs: results.slice(0, 8).map((tab) => ({
        title: tab.tabTitle || "",
        url: tab.tabUrl || "",
        ok: tab.ok !== false,
        candidates: Number(tab.candidates || 0),
        received: Number(tab.received || 0),
        error: tab.error || "",
        diagnostics: tab.diagnostics || {}
      }))
    }
  });
  await sendHeartbeat({ lastStudioScan: await buildLastStudioScanPayload() }).catch(() => {});
  return { ok: true, tabs: results, diagnosis: buildScanDiagnosis(results) };
}

async function collectScrapeTabs() {
  const [studioTabs, youtubeTabs] = await Promise.all([
    chrome.tabs.query({ url: "https://studio.youtube.com/*" }),
    chrome.tabs.query({ url: "https://www.youtube.com/*" })
  ]);
  const watcherTab = await getNotificationWatcherTab();
  const notificationTabs = youtubeTabs.filter((tab) => isLikelyNotificationTab(tab));
  const enrichedStudioTabs = [];
  for (const tab of studioTabs) {
    enrichedStudioTabs.push(await enrichStudioTab(tab));
  }
  const ranked = [
    ...(watcherTab ? [{ ...watcherTab, scanKind: "youtube_bell_watcher", scanRank: 0 }] : []),
    ...notificationTabs.map((tab) => ({ ...tab, scanKind: "youtube_notifications", scanRank: 1 })),
    ...enrichedStudioTabs.map((tab) => ({ ...tab, scanKind: classifyStudioTab(tab), scanRank: rankStudioTab(tab) }))
  ].sort((a, b) => a.scanRank - b.scanRank || String(a.title || "").localeCompare(String(b.title || "")));

  const map = new Map();
  for (const tab of ranked) {
    if (!tab.id) continue;
    const key = scrapeTabKey(tab);
    if (!map.has(key)) map.set(key, tab);
  }
  return Array.from(map.values()).slice(0, 12);
}

function isLikelyNotificationTab(tab) {
  const text = `${tab.url || ""} ${tab.title || ""}`.toLowerCase();
  return text.includes("/notifications") || text.includes("notifications") || text.includes("bildirim");
}

async function enrichStudioTab(tab) {
  if (!tab?.id) return tab;
  try {
    await ensureContentScript(tab.id);
    const status = await chrome.tabs.sendMessage(tab.id, { type: "studio-tab-status" });
    return { ...tab, studioStatus: status || {} };
  } catch {
    return { ...tab, studioStatus: {} };
  }
}

function classifyStudioTab(tab) {
  const url = String(tab.url || "");
  if (/\/channel\/UC[A-Za-z0-9_-]{10,}/i.test(url)) return "studio_channel";
  if (/\/video\/[A-Za-z0-9_-]{6,}/i.test(url)) return "studio_video";
  return "studio_other";
}

function rankStudioTab(tab) {
  const kind = classifyStudioTab(tab);
  if (kind === "studio_channel") return 10;
  if (kind === "studio_other") return 20;
  return 30;
}

function scrapeTabKey(tab) {
  if (tab.scanKind === "youtube_bell_watcher") return `youtube_bell_watcher:${tab.id}`;
  if (tab.scanKind === "youtube_notifications" || isLikelyNotificationTab(tab)) return `youtube_notifications:${new URL(tab.url || "https://www.youtube.com").origin}`;
  const url = String(tab.url || "");
  const videoId = url.match(/\/video\/([A-Za-z0-9_-]{6,})/)?.[1] || "";
  if (videoId) return `studio_video:${videoId}`;
  const channelId = url.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || tab.studioStatus?.channelId || "";
  if (channelId) return `studio_channel:${channelId}`;
  const channelName = tab.studioStatus?.channel || "";
  if (channelName) return `studio_channel_name:${channelName.toLowerCase()}`;
  return `tab:${tab.id}`;
}

function summarizeTabScanResult(tab) {
  return {
    tabId: tab.tabId,
    tabTitle: tab.tabTitle || "",
    tabUrl: tab.tabUrl || "",
    ok: tab.ok !== false,
    error: tab.error || "",
    received: Number(tab.received || 0),
      matched: Number(tab.matched || 0),
      unmatched: Number(tab.unmatched || 0),
      ignored: Number(tab.ignored || 0),
      youtubeResolved: Number(tab.youtubeResolved || 0),
      candidates: Number(tab.candidates || 0),
    diagnostics: tab.diagnostics || {},
    previews: Array.isArray(tab.previews) ? tab.previews.slice(0, 5) : []
  };
}

function summarizeScanResults(results) {
  return results.reduce(
    (total, item) => {
      total.tabs += 1;
      if (item.ok === false) total.failed += 1;
      total.received += Number(item.received || 0);
      total.matched += Number(item.matched || 0);
        total.unmatched += Number(item.unmatched || 0);
        total.ignored += Number(item.ignored || 0);
        total.youtubeResolved += Number(item.youtubeResolved || 0);
        total.candidates += Number(item.candidates || 0);
      return total;
    },
      { tabs: 0, failed: 0, received: 0, matched: 0, unmatched: 0, ignored: 0, youtubeResolved: 0, candidates: 0 }
  );
}

function buildScanDiagnosis(results) {
  const totals = summarizeScanResults(results);
  const tabs = results.map((item) => ({ ...item, diagnostics: item.diagnostics || {} }));
  const menuOpened = tabs.filter((item) => item.diagnostics.menuOpened).length;
  const notificationButtons = tabs.filter((item) => item.diagnostics.notificationButtonFound).length;
  const visibleContainers = tabs.reduce((sum, item) => sum + Number(item.diagnostics.visibleNotificationContainers || 0), 0);
  const bodySnippetCount = tabs.reduce((sum, item) => sum + Number(item.diagnostics.bodySnippetCount || 0), 0);

  if (!totals.tabs) {
    return {
      severity: "warn",
      code: "no_studio_tabs",
      message: "No Studio or YouTube bell tabs were open during the extension scan.",
      action: "Open a watched Studio channel or YouTube home from the extension, then scan again."
    };
  }
  if (totals.failed >= totals.tabs) {
    return {
      severity: "warn",
      code: "all_tabs_failed",
      message: "The extension could not read any open Studio tab.",
      action: "Reload the Studio tabs, confirm Chrome extension permissions, then scan again."
    };
  }
  if (totals.candidates > 0 && totals.received === 0 && totals.ignored === 0) {
    return {
      severity: "warn",
      code: "send_failed",
      message: "The extension found A/B finish text but the app did not record it.",
      action: "Check the connector token and app URL in extension settings."
    };
  }
  if (totals.candidates > 0 && totals.unmatched > 0 && totals.matched === 0) {
    return {
      severity: "info",
      code: "needs_matching",
      message: "Finish signals were captured, but none matched a known sheet row.",
      action: "The dashboard will show them as unregistered if automatic matching cannot resolve them."
    };
  }
  if (totals.candidates > 0) {
    return {
      severity: "ok",
      code: "signals_found",
      message: "A/B finish signals were captured and sent to the app.",
      action: ""
    };
  }
  if (!notificationButtons) {
    return {
      severity: "warn",
      code: "notification_button_missing",
      message: "No Studio notification button was found in the checked tabs.",
      action: "Open the normal Studio channel page, not only a video editor or analytics page, then scan again."
    };
  }
  if (!menuOpened && !visibleContainers) {
    return {
      severity: "warn",
      code: "notification_surface_missing",
      message: "Studio was open, but the extension could not open or see the notification list.",
      action: "Open the bell notifications panel manually, keep it visible, then scan again."
    };
  }
  if (bodySnippetCount > 0) {
    return {
      severity: "warn",
      code: "parser_missed_visible_text",
      message: "The page contained A/B-looking text, but no event was sent.",
      action: "This is likely a parser issue; share the Latest extension scan details."
    };
  }
  return {
    severity: "info",
    code: "no_finish_text_seen",
    message: "The extension scanned Studio successfully, but no A/B finish text was visible.",
    action: "If YouTube notifications are visible, open the bell panel and run Check now again."
  };
}

async function ensureContentScript(tabId) {
  const loaded = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__youtubeAbTestsConnectorLoaded)
    })
    .then((results) => Boolean(results?.[0]?.result))
    .catch(() => false);
  if (loaded) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  await delay(100);
}

async function ensureAppBridge(tabId) {
  const loaded = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__youtubeAbTestsAppBridgeLoaded)
    })
    .then((results) => Boolean(results?.[0]?.result))
    .catch(() => false);
  if (loaded) return { injected: false };
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["app-bridge.js"]
  });
  await delay(50);
  return { injected: true };
}

async function injectAppBridgeIntoAppTabs() {
  const tabs = await chrome.tabs.query({ url: APP_BRIDGE_MATCHES });
  const results = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const result = await ensureAppBridge(tab.id);
      results.push({ tabId: tab.id, url: tab.url || "", ok: true, ...result });
    } catch (error) {
      results.push({ tabId: tab.id, url: tab.url || "", ok: false, error: error.message });
    }
  }
  const payload = {
    ok: true,
    checked: results.length,
    injected: results.filter((item) => item.injected).length,
    failed: results.filter((item) => item.ok === false).length,
    results
  };
  await chrome.storage.local.set({
    lastAppBridgeRepairAt: new Date().toISOString(),
    lastAppBridgeRepairResult: payload
  }).catch(() => {});
  return payload;
}

async function postEvents(events, tabUrl) {
  if (!events.length) return { ok: true, received: 0 };
  const settings = await getSettings();
  requireConfigured(settings);
  const response = await fetch(`${cleanAppUrl(settings.appUrl)}/api/connector/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.connectorToken}`
    },
    body: JSON.stringify({
      connectorId: settings.connectorId,
      actorName: settings.actorName,
      version: EXTENSION_VERSION,
      source: "studio_bell",
      location: tabUrl,
      events
    })
  });
  const payload = await response.json().catch(() => ({}));
  await chrome.storage.local.set({
    lastEventPostAt: new Date().toISOString(),
    lastEventPostResult: payload,
    lastEventPostOk: response.ok
  });
  if (!response.ok) {
    await appendDiagnosticLog({
      category: "connector_events",
      severity: "error",
      message: payload.error || `Connector event post failed: ${response.status}`,
      context: { status: response.status, tabUrl, events: events.length }
    });
    throw new Error(payload.error || `Connector event post failed: ${response.status}`);
  }
  await appendDiagnosticLog({
    category: "connector_events",
    severity: payload.matched ? "info" : "warning",
    message: "Connector events posted",
    context: {
      tabUrl,
      received: payload.received || events.length,
        matched: payload.matched || 0,
        unmatched: payload.unmatched || 0,
        ignored: payload.ignored || 0,
        youtubeResolved: payload.youtubeResolved || 0
      }
  });
  return payload;
}

async function openWatcherTabs(requestedTargets = [], options = {}) {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const watcherTabs = requestedTargets.length ? requestedTargets : config.watcherTabs || [];
  const targets = watcherTabs.length
    ? watcherTabs
    : [{ label: "YouTube Studio", url: "https://studio.youtube.com" }];
  const openStudioUrls = (await chrome.tabs.query({ url: "https://studio.youtube.com/*" }))
    .map((tab) => tab.url || "")
    .filter(Boolean);
  const targetsToOpen = options.onlyMissing
    ? targets.filter((target) => !isWatcherTargetOpen(target, openStudioUrls))
    : targets;
  const opened = [];
  for (const target of targetsToOpen) {
    if (!target.url) continue;
    const tab = await chrome.tabs.create({ url: target.url, active: false });
    opened.push({ label: target.label || target.url, url: target.url, tabId: tab.id });
  }
  if (opened.length) await delay(1500);
  const heartbeat = await sendHeartbeat().catch((error) => ({ ok: false, error: error.message }));
  let scan = null;
  if (options.runScan !== false) {
    if (opened.length) await delay(1500);
    scan = await requestStudioScrapeGuarded().catch((error) => ({ ok: false, error: error.message }));
  }
  await chrome.storage.local.set({
    lastWatcherOpenAt: new Date().toISOString(),
    lastWatcherOpenCount: opened.length
  });
  return {
    ok: true,
    opened,
    alreadyOpen: targets.length - targetsToOpen.length,
    totalTargets: targets.length,
    heartbeat,
    scan
  };
}

function isWatcherTargetOpen(target, openStudioUrls) {
  const url = String(target?.url || "").replace(/\/+$/, "");
  const channelId = url.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  if (channelId) return openStudioUrls.some((item) => String(item).includes(channelId));
  return url ? openStudioUrls.some((item) => String(item).replace(/\/+$/, "").startsWith(url)) : false;
}

async function openNotificationPage() {
  const existing = await getNotificationWatcherTab();
  if (existing?.id) {
    const update = isUnavailableNotificationUrl(existing.url) ? { active: true, url: NOTIFICATION_WATCHER_URL } : { active: true };
    const tab = await chrome.tabs.update(existing.id, update);
    await chrome.storage.local.set({ notificationWatcherTabId: existing.id });
    return { ok: true, reused: true, tabId: existing.id, url: tab.url || existing.url || NOTIFICATION_WATCHER_URL };
  }

  const youtubeTabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const reusable = youtubeTabs.find((tab) => !isUnavailableNotificationUrl(tab.url));
  if (reusable?.id) {
    await chrome.tabs.update(reusable.id, { active: true });
    await chrome.storage.local.set({ notificationWatcherTabId: reusable.id });
    return { ok: true, reused: true, tabId: reusable.id, url: reusable.url || NOTIFICATION_WATCHER_URL };
  }

  const created = await chrome.tabs.create({ url: NOTIFICATION_WATCHER_URL, active: true });
  await chrome.storage.local.set({ notificationWatcherTabId: created.id });
  return { ok: true, reused: false, tabId: created.id, url: created.url || NOTIFICATION_WATCHER_URL };
}

async function getNotificationWatcherTab() {
  const local = await chrome.storage.local.get(["notificationWatcherTabId"]).catch(() => ({}));
  const tabId = Number(local.notificationWatcherTabId || 0);
  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.id && /^https:\/\/www\.youtube\.com\//i.test(tab.url || "")) return tab;
  }
  return null;
}

function isUnavailableNotificationUrl(url) {
  return /^https:\/\/www\.youtube\.com\/notifications(?:[/?#]|$)/i.test(String(url || ""));
}

async function reportMissedNotification() {
  await appendDiagnosticLog({
    category: "user_reported_miss",
    severity: "warning",
    message: "User reported a visible A/B finish notification that was not captured",
    context: { reportedAt: new Date().toISOString() }
  });
  const scan = await requestStudioScrapeGuarded().catch((error) => ({ ok: false, error: error.message }));
  const heartbeat = await sendHeartbeat({ userReportedMiss: true, lastStudioScan: await buildLastStudioScanPayload() })
    .catch((error) => ({ ok: false, error: error.message }));
  return { ok: scan.ok !== false, scan, heartbeat };
}

async function fetchConnectorConfig(settings) {
  const response = await fetch(`${cleanAppUrl(settings.appUrl)}/api/connector/config`, {
    headers: {
      "Authorization": `Bearer ${settings.connectorToken}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Connector config failed: ${response.status}`);
  await chrome.storage.local.set({
    lastConnectorConfigAt: new Date().toISOString(),
    lastConnectorConfig: payload
  });
  return payload;
}

async function deepScanActiveVideos() {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const activeTests = Array.isArray(config.activeTests) ? config.activeTests : [];
  const targets = uniqueStudioTargets(activeTests).slice(0, DEEP_SCAN_LIMIT);
  const opened = [];
  const results = [];

  for (const target of targets) {
    try {
      const tab = await chrome.tabs.create({ url: target.studioUrl, active: false });
      opened.push({ tabId: tab.id, videoId: target.videoId, channel: target.channel, title: target.videoTitle });
    } catch (error) {
      results.push({ ok: false, videoId: target.videoId, error: error.message });
    }
  }

  if (opened.length) await delay(5000);

  for (const item of opened) {
    try {
      await ensureContentScript(item.tabId);
      const response = await chrome.tabs.sendMessage(item.tabId, { type: "scrape-studio-notifications" });
      results.push({ ...item, ...response });
    } catch (error) {
      results.push({ ...item, ok: false, error: error.message });
    }
  }

  await delay(500);
  const tabIds = opened.map((item) => item.tabId).filter(Boolean);
  if (tabIds.length) {
    await chrome.tabs.remove(tabIds).catch(() => {});
  }

  const received = results.reduce((sum, item) => sum + Number(item.received || item.inserted || 0), 0);
  await chrome.storage.local.set({
    lastDeepScanAt: new Date().toISOString(),
    lastDeepScanCount: targets.length,
    lastDeepScanResult: { opened: opened.length, scanned: results.length, received }
  });

  return {
    ok: true,
    limit: DEEP_SCAN_LIMIT,
    candidates: activeTests.length,
    opened: opened.length,
    scanned: results.length,
    received,
    results
  };
}

async function sendHeartbeat(extraPayload = {}) {
  const settings = await getSettings();
  requireConfigured(settings);
  const appBridge = await injectAppBridgeIntoAppTabs().catch(async (error) => {
    const payload = {
      ok: false,
      checked: 0,
      injected: 0,
      failed: 1,
      error: error.message,
      results: []
    };
    await chrome.storage.local.set({
      lastAppBridgeRepairAt: new Date().toISOString(),
      lastAppBridgeRepairResult: payload
    }).catch(() => {});
    await appendDiagnosticLog({
      category: "app_bridge",
      severity: "warning",
      message: "Dashboard bridge repair failed",
      context: { error: error.message }
    });
    return payload;
  });
  const studioTabs = await chrome.tabs.query({ url: "https://studio.youtube.com/*" });
  const notificationWatcherTab = await getNotificationWatcherTab();
  const studioTabDetails = await collectStudioTabDetails(studioTabs);
  const lastStudioScan = extraPayload.lastStudioScan === undefined
    ? await buildLastStudioScanPayload()
    : extraPayload.lastStudioScan;
  const heartbeatPayload = {
    location: "chrome-extension",
    openStudioTabs: studioTabs.length,
    studioTabUrls: studioTabs.map((tab) => tab.url || "").filter(Boolean).slice(0, 10),
    notificationWatcherOpen: Boolean(notificationWatcherTab),
    notificationWatcherUrl: notificationWatcherTab?.url || "",
    studioTabs: studioTabDetails.slice(0, 10),
    appBridge,
    userAgent: navigator.userAgent,
    observedAt: new Date().toISOString(),
    diagnosticLog: await readDiagnosticLog(),
    ...extraPayload,
    lastStudioScan
  };
  const response = await fetch(`${cleanAppUrl(settings.appUrl)}/api/connector/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.connectorToken}`
    },
    body: JSON.stringify({
      connectorId: settings.connectorId,
      actorName: settings.actorName,
      version: EXTENSION_VERSION,
      channels: splitChannels(settings.channels),
      status: "online",
      ...heartbeatPayload
    })
  });
  const responsePayload = await response.json().catch(() => ({}));
  await chrome.storage.local.set({
    lastHeartbeatAt: new Date().toISOString(),
    lastHeartbeatOk: response.ok,
    lastHeartbeatResult: responsePayload
  });
  if (!response.ok) {
    await appendDiagnosticLog({
      category: "heartbeat",
      severity: "error",
      message: responsePayload.error || `Heartbeat failed: ${response.status}`,
      context: { status: response.status }
    });
    throw new Error(responsePayload.error || `Heartbeat failed: ${response.status}`);
  }
  return responsePayload;
}

async function collectStudioTabDetails(studioTabs) {
  const details = [];
  for (const tab of studioTabs.slice(0, 10)) {
    const base = {
      tabId: tab.id,
      tabTitle: tab.title || "",
        tabUrl: tab.url || "",
        channel: "",
        channelId: "",
        notificationButtonFound: false,
      visibleNotificationContainers: 0,
      bodySnippetCount: 0,
      ok: true,
      error: ""
    };
    try {
      await ensureContentScript(tab.id);
      const status = await chrome.tabs.sendMessage(tab.id, { type: "studio-tab-status" });
        details.push({
          ...base,
          channel: status?.channel || "",
          channelId: status?.channelId || "",
          notificationButtonFound: Boolean(status?.notificationButtonFound),
        visibleNotificationContainers: Number(status?.visibleNotificationContainers || 0),
        bodySnippetCount: Number(status?.bodySnippetCount || 0)
      });
    } catch (error) {
      details.push({ ...base, ok: false, error: error.message });
    }
  }
  return details;
}

async function buildLastStudioScanPayload() {
  const local = await chrome.storage.local.get(["lastStudioScanAt", "lastStudioScanResult"]);
  if (!local.lastStudioScanAt) return null;
  const result = local.lastStudioScanResult || {};
  return {
    checkedAt: local.lastStudioScanAt,
    totals: result.totals || {},
    tabs: Array.isArray(result.tabs)
      ? result.tabs.slice(0, 8).map((tab) => ({
          tabTitle: tab.tabTitle || "",
          tabUrl: tab.tabUrl || "",
          ok: tab.ok !== false,
          error: tab.error || "",
          received: Number(tab.received || 0),
          matched: Number(tab.matched || 0),
          unmatched: Number(tab.unmatched || 0),
          candidates: Number(tab.candidates || 0),
          menuOpened: Boolean(tab.diagnostics?.menuOpened),
          channel: tab.diagnostics?.channel || "",
          previews: Array.isArray(tab.previews) ? tab.previews.slice(0, 3) : []
        }))
      : [],
    diagnosis: sanitizeDiagnosis(result.diagnosis)
  };
}

function sanitizeDiagnosis(value) {
  if (!value || typeof value !== "object") return null;
  return {
    severity: String(value.severity || "info").slice(0, 20),
    code: String(value.code || "").slice(0, 80),
    message: String(value.message || "").slice(0, 240),
    action: String(value.action || "").slice(0, 240)
  };
}

async function appendDiagnosticLog({ category, severity = "info", message = "", context = {} }) {
  const local = await chrome.storage.local.get(["diagnosticLog"]).catch(() => ({ diagnosticLog: [] }));
  const entries = Array.isArray(local.diagnosticLog) ? local.diagnosticLog : [];
  const next = [
    ...entries,
    {
      at: new Date().toISOString(),
      category,
      severity,
      message,
      context: redactDiagnosticContext(context)
    }
  ].slice(-50);
  await chrome.storage.local.set({ diagnosticLog: next }).catch(() => {});
}

async function readDiagnosticLog() {
  const local = await chrome.storage.local.get(["diagnosticLog"]).catch(() => ({ diagnosticLog: [] }));
  return Array.isArray(local.diagnosticLog) ? local.diagnosticLog.slice(-20) : [];
}

function redactDiagnosticContext(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map(redactDiagnosticContext);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).slice(0, 30).map(([key, item]) => {
      if (/token|password|secret|key|authorization|credential/i.test(key)) return [key, item ? "[redacted]" : ""];
      if (typeof item === "string") return [key, item.slice(0, 300)];
      return [key, redactDiagnosticContext(item)];
    })
  );
}

async function getSettings() {
  return {
    ...DEFAULT_SETTINGS,
    ...(await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS)))
  };
}

function requireConfigured(settings) {
  if (!settings.appUrl || !settings.connectorToken) {
    throw new Error("Open extension options and configure cloud app URL plus connector token.");
  }
}

function cleanAppUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function splitChannels(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStudioTargets(activeTests) {
  const map = new Map();
  for (const run of activeTests) {
    if (!run?.studioUrl || !run.videoId) continue;
    if (map.has(run.videoId)) continue;
    map.set(run.videoId, {
      videoId: run.videoId,
      studioUrl: run.studioUrl,
      channel: run.channel || "",
      videoTitle: run.videoTitle || ""
    });
  }
  return Array.from(map.values());
}

function minutesUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(now.getHours() + 1);
  return Math.max(1, Math.ceil((next - now) / 60000));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
