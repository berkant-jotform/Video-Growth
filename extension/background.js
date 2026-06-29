const EXTENSION_VERSION = "0.1.11";
const DEEP_SCAN_LIMIT = 8;
const DEFAULT_SETTINGS = {
  appUrl: "https://video-growth.vercel.app",
  connectorToken: "",
  actorName: "",
  channels: "Jotform, AI Agents Podcast, AI Agents",
  connectorId: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (!settings.connectorId) {
    await chrome.storage.sync.set({ connectorId: crypto.randomUUID() });
  }
  scheduleHourlyAlarm();
});

chrome.runtime.onStartup.addListener(() => scheduleHourlyAlarm());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "youtube-ab-heartbeat") return;
  await sendHeartbeat();
  await requestStudioScrape();
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
    requestStudioScrape()
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
    openWatcherTabs(message.targets || [])
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
  return false;
});

function scheduleHourlyAlarm() {
  chrome.alarms.create("youtube-ab-heartbeat", {
    delayInMinutes: minutesUntilNextHour(),
    periodInMinutes: 60
  });
}

async function requestStudioScrape() {
  const tabs = await chrome.tabs.query({ url: "https://studio.youtube.com/*" });
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
      totals: summarizeScanResults(results)
    }
  });
  await sendHeartbeat({ lastStudioScan: await buildLastStudioScanPayload() }).catch(() => {});
  return { ok: true, tabs: results };
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
      total.candidates += Number(item.candidates || 0);
      return total;
    },
    { tabs: 0, failed: 0, received: 0, matched: 0, unmatched: 0, ignored: 0, candidates: 0 }
  );
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
  if (!response.ok) throw new Error(payload.error || `Connector event post failed: ${response.status}`);
  return payload;
}

async function openWatcherTabs(requestedTargets = []) {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const watcherTabs = requestedTargets.length ? requestedTargets : config.watcherTabs || [];
  const targets = watcherTabs.length
    ? watcherTabs
    : [{ label: "YouTube Studio", url: "https://studio.youtube.com" }];
  const opened = [];
  for (const target of targets) {
    if (!target.url) continue;
    const tab = await chrome.tabs.create({ url: target.url, active: opened.length === 0 });
    opened.push({ label: target.label || target.url, url: target.url, tabId: tab.id });
  }
  const heartbeat = await sendHeartbeat().catch((error) => ({ ok: false, error: error.message }));
  await delay(2500);
  const scan = await requestStudioScrape().catch((error) => ({ ok: false, error: error.message }));
  await chrome.storage.local.set({
    lastWatcherOpenAt: new Date().toISOString(),
    lastWatcherOpenCount: opened.length
  });
  return { ok: true, opened, heartbeat, scan };
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
  const studioTabs = await chrome.tabs.query({ url: "https://studio.youtube.com/*" });
  const lastStudioScan = extraPayload.lastStudioScan === undefined
    ? await buildLastStudioScanPayload()
    : extraPayload.lastStudioScan;
  const heartbeatPayload = {
    location: "chrome-extension",
    openStudioTabs: studioTabs.length,
    studioTabUrls: studioTabs.map((tab) => tab.url || "").filter(Boolean).slice(0, 10),
    userAgent: navigator.userAgent,
    observedAt: new Date().toISOString(),
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
  if (!response.ok) throw new Error(responsePayload.error || `Heartbeat failed: ${response.status}`);
  return responsePayload;
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
      : []
  };
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
