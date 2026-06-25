const EXTENSION_VERSION = "0.1.0";
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
  if (message?.type === "open-watcher-tabs") {
    openWatcherTabs()
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
      const response = await chrome.tabs.sendMessage(tab.id, { type: "scrape-studio-notifications" });
      results.push({ tabId: tab.id, ...response });
    } catch (error) {
      results.push({ tabId: tab.id, ok: false, error: error.message });
    }
  }
  return { ok: true, tabs: results };
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

async function openWatcherTabs() {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const watcherTabs = config.watcherTabs || [];
  const targets = watcherTabs.length
    ? watcherTabs
    : [{ label: "YouTube Studio", url: "https://studio.youtube.com" }];
  const opened = [];
  for (const target of targets) {
    if (!target.url) continue;
    const tab = await chrome.tabs.create({ url: target.url, active: opened.length === 0 });
    opened.push({ label: target.label || target.url, url: target.url, tabId: tab.id });
  }
  await chrome.storage.local.set({
    lastWatcherOpenAt: new Date().toISOString(),
    lastWatcherOpenCount: opened.length
  });
  return { ok: true, opened };
}

async function fetchConnectorConfig(settings) {
  const response = await fetch(`${cleanAppUrl(settings.appUrl)}/api/connector/config`, {
    headers: {
      "Authorization": `Bearer ${settings.connectorToken}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Connector config failed: ${response.status}`);
  return payload;
}

async function sendHeartbeat() {
  const settings = await getSettings();
  requireConfigured(settings);
  const studioTabs = await chrome.tabs.query({ url: "https://studio.youtube.com/*" });
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
      location: "chrome-extension",
      openStudioTabs: studioTabs.length,
      studioTabUrls: studioTabs.map((tab) => tab.url || "").filter(Boolean).slice(0, 10),
      userAgent: navigator.userAgent,
      observedAt: new Date().toISOString()
    })
  });
  const payload = await response.json().catch(() => ({}));
  await chrome.storage.local.set({
    lastHeartbeatAt: new Date().toISOString(),
    lastHeartbeatOk: response.ok,
    lastHeartbeatResult: payload
  });
  if (!response.ok) throw new Error(payload.error || `Heartbeat failed: ${response.status}`);
  return payload;
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

function minutesUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(now.getHours() + 1);
  return Math.max(1, Math.ceil((next - now) / 60000));
}
