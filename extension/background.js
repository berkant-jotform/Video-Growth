import {
  EXTENSION_CAPABILITIES,
  EXTENSION_VERSION,
  channelIdentityConflict,
  finalJobStatus,
  nextRetryAt,
  progressPercent,
  shouldRetryOutboxItem,
  stableEventKey,
  summarizeChannelCoverage
} from "./reliability-core.js";
const DEEP_SCAN_LIMIT = 8;
const NOTIFICATION_WATCHER_URL = "https://www.youtube.com/";
const APP_BRIDGE_MATCHES = ["https://video-growth.vercel.app/*", "http://127.0.0.1:8770/*"];
const PENDING_EVENT_QUEUE_KEY = "pendingConnectorEvents";
const RECENT_EVENT_KEYS_KEY = "recentConnectorEventKeys";
const MAX_PENDING_EVENTS = 200;
const DEAD_EVENT_QUEUE_KEY = "deadConnectorEvents";
const MAX_DEAD_EVENTS = 50;
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RUNTIME_CONFIG_STORAGE_KEY = "extensionRuntimeConfig";
const OWNED_WATCHERS_KEY = "ownedStudioWatchers";
const DEFAULT_RUNTIME_CONFIG = {
  version: "2026-08-31.1",
  passiveScanMinutes: 60,
  commandPollMinutes: 1,
  startupCatchupMinutes: 20,
  waitAfterOpenMs: 1200,
  waitForRowsMs: 4500,
  scrollRounds: 3,
  scrollDelayMs: 650,
  scanOrder: "youtube_first",
  openYoutubeFallback: true,
  deepScanFallbackEnabled: false,
  includeSeenOnManualScan: true,
  accessibleLabelsEnabled: true,
  notificationSelectors: [],
  notificationButtonSelectors: [],
  notificationSurfaceSelectors: [],
  minTextLength: 18,
  maxTextLength: 700,
  maxEvents: 60,
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
const DEFAULT_SETTINGS = {
  appUrl: "https://video-growth.vercel.app",
  connectorToken: "",
  actorName: "",
  channels: "Jotform, AI Agents Podcast, AI Agents",
  connectorId: ""
};
let studioScrapePromise = null;
let watcherOpenPromise = null;
let connectorJobPromise = null;

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (!settings.connectorId) {
    await chrome.storage.sync.set({ connectorId: crypto.randomUUID() });
  }
  scheduleHourlyAlarm();
  scheduleCommandAlarm();
  await injectAppBridgeIntoAppTabs().catch(() => {});
  await recoverInterruptedOperation().catch(() => {});
  await processQueuedConnectorJobs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  runStartupMaintenance().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isAppBridgeUrl(tab?.url || "")) return;
  ensureAppBridge(tabId).catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "youtube-ab-command-poll") {
    await flushPendingEvents().catch(() => null);
    await processQueuedConnectorJobs().catch((error) => appendDiagnosticLog({
      category: "connector_jobs",
      severity: "warning",
      message: "Queued app check could not run",
      context: { error: error.message }
    }));
    return;
  }
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
  await processQueuedConnectorJobs().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "studio-notifications") {
    prepareSourceEvents(message.events || [], sender.tab)
      .then(({ events, rejected }) => postEvents(events, sender.tab?.url || "", {
        forcePost: Boolean(message.forcePost),
        channelScope: message.channelScope || [],
        testTypeScope: message.testTypeScope || "all"
      }).then((result) => ({ ...result, identityRejected: rejected })))
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
  if (message?.type === "get-control-status") {
    buildControlStatus()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "scan-studio-tab") {
    requestStudioScrapeGuarded({
      userInitiated: Boolean(message.interactive || message.userInitiated),
      avoidTabSwitch: message.avoidTabSwitch !== false,
      channelScope: message.channelScope || [],
      testTypeScope: message.testTypeScope || "all"
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "run-scan-job") {
    requestConnectorScanJobGuarded(message.jobId || "")
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "pair-extension") {
    pairExtension(message.payload || {})
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

function scheduleHourlyAlarm(minutes = 60) {
  const interval = Math.max(15, Math.min(240, Number(minutes) || 60));
  chrome.alarms.create("youtube-ab-heartbeat", {
    delayInMinutes: interval === 60 ? minutesUntilNextHour() : Math.min(interval, 5),
    periodInMinutes: interval
  });
}

async function runStartupMaintenance() {
  scheduleHourlyAlarm();
  scheduleCommandAlarm();
  await injectAppBridgeIntoAppTabs().catch(() => {});
  await recoverInterruptedOperation().catch(() => {});
  await sendHeartbeat().catch(() => {});
  await processQueuedConnectorJobs().catch(() => {});
  await runStartupCatchupIfNeeded().catch(() => {});
}

async function buildControlStatus() {
  const [settings, ownedWatchers, pending, local] = await Promise.all([
    getSettings(),
    readOwnedWatchers(),
    pendingQueueState(),
    chrome.storage.local.get(["activeConnectorJob", "lastStudioScanAt", "lastStudioScanResult", "lastRuntimeConfigAt", "lastRuntimeConfigOk"])
  ]);
  return {
    ok: true,
    version: EXTENSION_VERSION,
    configured: Boolean(settings.appUrl && settings.connectorToken),
    connectorId: settings.connectorId || "",
    capabilities: EXTENSION_CAPABILITIES,
    ownedWatchers,
    pending,
    activeJob: local.activeConnectorJob || null,
    lastScanAt: local.lastStudioScanAt || "",
    lastScan: local.lastStudioScanResult || null,
    runtimeConfig: {
      checkedAt: local.lastRuntimeConfigAt || "",
      ok: local.lastRuntimeConfigOk !== false
    }
  };
}

async function prepareSourceEvents(events, tab) {
  const watcher = tab?.id ? await ownedWatcherForTab(tab.id) : null;
  if (!watcher) {
    return {
      events: events.map((event) => ({ ...event, sourceTabId: tab?.id || 0 })),
      rejected: 0
    };
  }
  const expectedId = watcher.channelId || "";
  const urlChannelId = String(tab.url || "").match(/\/channel\/(UC[A-Za-z0-9_-]{10,})/i)?.[1] || "";
  const observedIds = Array.from(new Set(events.map((event) => String(event.channelId || "").trim()).filter(Boolean)));
  const identityConflict = channelIdentityConflict(expectedId, observedIds, tab.url || "");
  if (identityConflict) {
    await appendDiagnosticLog({
      category: "channel_identity",
      severity: "error",
      message: "Dedicated watcher opened under an unexpected channel",
      context: { expectedChannel: watcher.label, expectedId, observedIds, urlChannelId, tabUrl: tab.url || "", events: events.length }
    });
    return { events: [], rejected: events.length };
  }
  return {
    events: events.map((event) => ({
      ...event,
      channel: watcher.label || event.channel || "",
      channelId: expectedId || event.channelId || "",
      channelIdentitySource: "owned_watcher",
      channelIdentityConfidence: expectedId ? "exact" : "label",
      sourceTabId: tab.id
    })),
    rejected: 0
  };
}

function scheduleCommandAlarm(minutes = 1) {
  const interval = Math.max(1, Math.min(15, Number(minutes) || 1));
  chrome.alarms.create("youtube-ab-command-poll", {
    delayInMinutes: interval,
    periodInMinutes: interval
  });
}

async function runStartupCatchupIfNeeded() {
  const [local, runtimeConfig] = await Promise.all([
    chrome.storage.local.get(["lastStudioScanAt"]),
    runtimeConfigForScan()
  ]);
  const lastScanAt = new Date(local.lastStudioScanAt || 0).getTime();
  const maxAge = Math.max(5, Number(runtimeConfig.startupCatchupMinutes || 20)) * 60_000;
  if (lastScanAt && Date.now() - lastScanAt < maxAge) return { ok: true, skipped: true };
  return requestStudioScrapeGuarded({ userInitiated: false, avoidTabSwitch: true });
}

async function pairExtension(payload = {}) {
  const appUrl = cleanAppUrl(payload.appUrl || DEFAULT_SETTINGS.appUrl);
  const current = await getSettings();
  const connectorId = current.connectorId || crypto.randomUUID();
  const response = await fetchWithTimeout(`${appUrl}/api/connector/pairings/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: payload.code || "",
      connectorId,
      deviceLabel: payload.deviceLabel || `${payload.actorName || "Reviewer"} Chrome`,
      version: EXTENSION_VERSION,
      capabilities: EXTENSION_CAPABILITIES
    })
  }, 20_000);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.device?.token) {
    throw new Error(result.error || "Browser pairing failed.");
  }
  await chrome.storage.local.set({ connectorToken: result.device.token });
  await chrome.storage.sync.set({
    appUrl,
    actorName: payload.actorName || current.actorName || "Reviewer",
    connectorId: result.device.connectorId || connectorId
  });
  await sendHeartbeat({ pairedAt: new Date().toISOString() });
  return {
    ok: true,
    connectorId: result.device.connectorId || connectorId,
    label: result.device.label || payload.deviceLabel || "Chrome",
    version: EXTENSION_VERSION
  };
}

async function processQueuedConnectorJobs() {
  return requestConnectorScanJobGuarded("");
}

function requestConnectorScanJobGuarded(requestedJobId = "") {
  if (connectorJobPromise) return connectorJobPromise;
  connectorJobPromise = runConnectorScanJob(requestedJobId).finally(() => {
    connectorJobPromise = null;
  });
  return connectorJobPromise;
}

async function runConnectorScanJob(requestedJobId = "") {
  const settings = await getSettings();
  requireConfigured(settings);
  const claim = await connectorApi(settings, "/api/connector/jobs/claim", {
    method: "POST",
    body: {
      connectorId: settings.connectorId,
      jobId: requestedJobId,
      version: EXTENSION_VERSION,
      capabilities: EXTENSION_CAPABILITIES
    }
  });
  const job = claim.job;
  if (!job) return {
    ok: !requestedJobId,
    accepted: false,
    queued: Boolean(requestedJobId),
    error: requestedJobId ? "This check is queued for another connected browser." : "",
    message: requestedJobId ? "Waiting for the browser assigned to these channels." : "No queued app checks."
  };
  const remoteConfig = await fetchConnectorConfig(settings).catch(() => null);
  const requestedChannels = Array.isArray(job.channels) && job.channels.length
    ? job.channels
    : Array.isArray(remoteConfig?.channels) ? remoteConfig.channels : splitChannels(settings.channels);
  await chrome.storage.local.set({
    activeConnectorJob: {
      jobId: job.jobId,
      channels: requestedChannels,
      testType: job.testType || "all",
      status: "running",
      startedAt: new Date().toISOString()
    }
  });
  await updateRemoteJob(settings, job.jobId, {
    status: "running",
    progress: jobProgress("starting", "Preparing browser check.", 4, requestedChannels)
  });
  let results = [];
  let cancelled = false;
  try {
    if (studioScrapePromise) await studioScrapePromise.catch(() => null);
    results = await requestStudioScrapeGuarded({
      userInitiated: true,
      avoidTabSwitch: true,
      channelScope: requestedChannels,
      testTypeScope: job.testType || "all",
      connectorJob: { jobId: job.jobId, settings, channels: requestedChannels }
    });
    const tabResults = Array.isArray(results?.tabs) ? results.tabs : [];
    cancelled = Boolean(results?.cancelled);
    const coverageInput = tabResults.map((tab) => ({
      ...tab,
      checked: tab.ok !== false,
      bellRead: Boolean(tab.diagnostics?.menuOpened && tab.diagnostics?.notificationOpenResult?.opened !== false),
      channel: tab.diagnostics?.channel || "",
      channelId: tab.diagnostics?.channelId || ""
    }));
    const coverage = summarizeChannelCoverage(coverageInput, requestedChannels);
    const status = finalJobStatus(coverage, cancelled);
    const totals = summarizeScanResults(tabResults);
    await updateRemoteJob(settings, job.jobId, {
      status,
      progress: jobProgress(status, jobCompletionMessage(status, coverage), 100, requestedChannels, coverage),
      result: { totals, coverage, diagnosis: results?.diagnosis || null, runtimeConfigVersion: results?.runtimeConfigVersion || "" }
    });
    return { ok: status !== "failed", accepted: true, jobId: job.jobId, status, tabs: tabResults, coverage };
  } catch (error) {
    await updateRemoteJob(settings, job.jobId, {
      status: "failed",
      error: error.message,
      progress: jobProgress("failed", error.message || "Browser check failed.", 100, requestedChannels)
    }).catch(() => null);
    throw error;
  } finally {
    await chrome.storage.local.remove("activeConnectorJob").catch(() => {});
  }
}

async function recoverInterruptedOperation() {
  const local = await chrome.storage.local.get(["activeConnectorJob"]).catch(() => ({}));
  const active = local.activeConnectorJob;
  if (!active?.jobId) return null;
  await chrome.storage.local.remove("activeConnectorJob").catch(() => {});
  return requestConnectorScanJobGuarded(active.jobId);
}

async function updateRemoteJob(settings, jobId, update) {
  return connectorApi(settings, `/api/connector/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    body: { connectorId: settings.connectorId, ...update }
  });
}

async function readRemoteJob(settings, jobId) {
  return connectorApi(settings, `/api/connector/jobs/${encodeURIComponent(jobId)}?connectorId=${encodeURIComponent(settings.connectorId || "")}`);
}

async function connectorJobCancelled(jobContext) {
  if (!jobContext?.jobId || !jobContext?.settings) return false;
  const result = await readRemoteJob(jobContext.settings, jobContext.jobId).catch(() => null);
  return ["cancel_requested", "cancelled"].includes(result?.job?.status);
}

async function connectorApi(settings, path, options = {}) {
  const response = await fetchWithTimeout(`${cleanAppUrl(settings.appUrl)}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.connectorToken}`
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  }, 20_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Extension control request failed: ${response.status}`);
  return payload;
}

function jobProgress(stage, message, percent, channels = [], coverage = []) {
  return {
    stage,
    message,
    percent,
    channels,
    coverage,
    updatedAt: new Date().toISOString()
  };
}

function jobCompletionMessage(status, coverage) {
  if (status === "cancelled") return "Check stopped safely. Signals already found were retained.";
  const checked = coverage.filter((item) => item.status === "checked").length;
  if (status === "partial") return `${checked} of ${coverage.length} requested channels were checked.`;
  return coverage.length ? `${checked} of ${coverage.length} requested channels were checked.` : "Browser check completed.";
}

function requestStudioScrapeGuarded(options = {}) {
  if (studioScrapePromise) return studioScrapePromise;
  studioScrapePromise = requestStudioScrape(options).finally(() => {
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

async function requestStudioScrape(options = {}) {
  const runtimeConfig = await runtimeConfigForScan();
  const scanOptions = { ...options, runtimeConfig };
  const initialTabs = await collectScrapeTabs({
    preferStudio: runtimeConfig.scanOrder === "studio_first" || !scanOptions.userInitiated,
    includeYoutube: true
  });
  if (!initialTabs.length && runtimeConfig.openYoutubeFallback) await ensureNotificationWatcherForScan(scanOptions);
  const tabs = initialTabs.length
    ? initialTabs
    : await collectScrapeTabs({ preferStudio: runtimeConfig.scanOrder === "studio_first" || !scanOptions.userInitiated, includeYoutube: true });
  let results = await scrapeTabs(tabs, scanOptions);
  const cancelled = results.some((item) => item.cancelled);
  if (!cancelled && runtimeConfig.openYoutubeFallback && shouldRetryWithNotificationWatcher(results, tabs, scanOptions)) {
    await openNotificationPage({ active: false }).catch(() => null);
    await delay(Math.max(1200, Number(runtimeConfig.waitAfterOpenMs || 1200) + 2000));
    const retryTabs = await collectScrapeTabs({ preferStudio: Boolean(scanOptions.userInitiated), includeYoutube: true });
    const retryResults = await scrapeTabs(retryTabs, scanOptions);
    results = mergeScanResults(results, retryResults);
  }
  if (!cancelled && shouldDeepScanFallback(results, scanOptions)) {
    const deepScan = await deepScanActiveVideos({ limit: 4, reason: "finish-signal-fallback" }).catch((error) => ({ ok: false, error: error.message }));
    if (Array.isArray(deepScan.results) && deepScan.results.length) {
      results = mergeScanResults(results, deepScan.results.map((item) => ({
        ...item,
        tabTitle: item.tabTitle || item.videoTitle || "Deep scan",
        tabUrl: item.tabUrl || item.studioUrl || "",
        diagnostics: {
          ...(item.diagnostics || {}),
          deepScanFallback: true,
          deepScanReason: deepScan.error || ""
        }
      })));
    }
  }
  await saveStudioScanResults(results, scanOptions);
  await sendHeartbeat({ lastStudioScan: await buildLastStudioScanPayload() }).catch(() => {});
  return { ok: true, cancelled, tabs: results, diagnosis: buildScanDiagnosis(results), scope: scanScopeSummary(scanOptions), runtimeConfigVersion: runtimeConfig.version || "" };
}

async function ensureNotificationWatcherForScan(options = {}) {
  const tab = await openNotificationPage({ active: Boolean(options.userInitiated && options.avoidTabSwitch === false) }).catch(() => null);
  if (tab?.tabId) await waitForTabReady(tab.tabId, 6000).catch(() => {});
  if (options.userInitiated && options.avoidTabSwitch === false && tab?.tabId) {
    await chrome.tabs.update(tab.tabId, { active: true }).catch(() => {});
    await delay(800);
  }
}

async function scrapeTabs(tabs, options = {}) {
  const results = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (await connectorJobCancelled(options.connectorJob)) {
      results.push({ ok: true, cancelled: true, tabId: tab.id, tabTitle: tab.title || "", tabUrl: tab.url || "" });
      break;
    }
    if (options.connectorJob?.jobId) {
      await updateRemoteJob(options.connectorJob.settings, options.connectorJob.jobId, {
        status: "running",
        progress: jobProgress(
          "checking",
          `Checking browser tab ${index + 1} of ${tabs.length}.`,
          progressPercent(index, tabs.length),
          options.connectorJob.channels
        )
      }).catch(() => null);
    }
    try {
      await waitForTabReady(tab.id, 3000).catch(() => {});
      await ensureContentScript(tab.id);
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "scrape-studio-notifications",
        forcePost: Boolean(options.userInitiated),
        channelScope: options.channelScope || [],
        testTypeScope: options.testTypeScope || "all",
        runtimeConfig: options.runtimeConfig || DEFAULT_RUNTIME_CONFIG
      });
      const expected = tab.expectedWatcher || null;
      const identityConflict = Boolean(expected && Number(response?.identityRejected || 0) > 0);
      results.push({
        tabId: tab.id,
        tabTitle: tab.title || "",
        tabUrl: tab.url || "",
        ...response,
        identityConflict,
        ...(identityConflict ? { ok: false, error: "Studio tab is showing a different channel than its watcher assignment." } : {}),
        diagnostics: {
          ...(response?.diagnostics || {}),
          ...(expected ? {
            channel: expected.label || response?.diagnostics?.channel || "",
            channelId: expected.channelId || response?.diagnostics?.channelId || "",
            channelIdentitySource: "owned_watcher"
          } : {})
        }
      });
    } catch (error) {
      results.push({ tabId: tab.id, tabTitle: tab.title || "", tabUrl: tab.url || "", ok: false, error: error.message });
    }
  }
  return results;
}

function shouldRetryWithNotificationWatcher(results, tabs, options = {}) {
  const totals = summarizeScanResults(results);
  if (totals.candidates || totals.received) return false;
  const hasYoutubeTab = tabs.some((tab) => /^https:\/\/www\.youtube\.com\//i.test(tab.url || ""));
  return Boolean(options.userInitiated || !hasYoutubeTab);
}

function shouldDeepScanFallback(results, options = {}) {
  if (options.runtimeConfig?.deepScanFallbackEnabled !== true) return false;
  if (!options.userInitiated) return false;
  const totals = summarizeScanResults(results);
  if (totals.candidates || totals.received || totals.duplicate || totals.queued) return false;
  return results.some((item) => /^https:\/\/studio\.youtube\.com\//i.test(item.tabUrl || ""));
}

function mergeScanResults(first, second) {
  const map = new Map();
  for (const item of [...first, ...second]) {
    const key = item.tabId || item.tabUrl || `${item.tabTitle}-${map.size}`;
    map.set(key, item);
  }
  return Array.from(map.values());
}

async function saveStudioScanResults(results, options = {}) {
  await chrome.storage.local.set({
    lastStudioScanAt: new Date().toISOString(),
    lastStudioScanResult: {
      tabs: results.map(summarizeTabScanResult),
      totals: summarizeScanResults(results),
      scope: scanScopeSummary(options),
      runtimeConfigVersion: options.runtimeConfig?.version || "",
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
}

function scanScopeSummary(options = {}) {
  const channels = Array.isArray(options.channelScope)
    ? options.channelScope.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const testType = ["title", "thumbnail"].includes(String(options.testTypeScope || "").toLowerCase())
    ? String(options.testTypeScope).toLowerCase()
    : "all";
  return { channels, testType };
}

async function collectScrapeTabs(options = {}) {
  const includeYoutube = options.includeYoutube !== false;
  const preferStudio = Boolean(options.preferStudio);
  const [studioTabs, youtubeTabs] = await Promise.all([
    chrome.tabs.query({ url: "https://studio.youtube.com/*" }),
    includeYoutube ? chrome.tabs.query({ url: "https://www.youtube.com/*" }) : Promise.resolve([])
  ]);
  const watcherTab = includeYoutube ? await getNotificationWatcherTab() : null;
  const notificationTabs = youtubeTabs.filter((tab) => isLikelyNotificationTab(tab));
  const youtubeFallbackTabs = youtubeTabs
    .filter((tab) => tab.id && tab.id !== watcherTab?.id && !notificationTabs.some((item) => item.id === tab.id))
    .slice(0, 2);
  const ownedWatchers = await readOwnedWatchers();
  const enrichedStudioTabs = [];
  for (const tab of studioTabs) {
    const expectedWatcher = ownedWatchers.find((item) => item.tabId === tab.id) || null;
    enrichedStudioTabs.push({ ...(await enrichStudioTab(tab)), expectedWatcher });
  }
  const ranked = [
    ...enrichedStudioTabs.map((tab) => ({
      ...tab,
      scanKind: classifyStudioTab(tab),
      scanRank: (preferStudio ? 0 : 10) + rankStudioTab(tab)
    })),
    ...(watcherTab ? [{ ...watcherTab, scanKind: "youtube_bell_watcher", scanRank: preferStudio ? 80 : 0 }] : []),
    ...notificationTabs.map((tab) => ({ ...tab, scanKind: "youtube_notifications", scanRank: preferStudio ? 81 : 1 })),
    ...youtubeFallbackTabs.map((tab) => ({ ...tab, scanKind: "youtube_fallback", scanRank: preferStudio ? 82 : 2 }))
  ].sort((a, b) => a.scanRank - b.scanRank || String(a.title || "").localeCompare(String(b.title || "")));

  const map = new Map();
  for (const tab of ranked) {
    if (!tab.id) continue;
    const key = scrapeTabKey(tab);
    if (!map.has(key)) map.set(key, tab);
  }
  const ownedCount = enrichedStudioTabs.filter((tab) => tab.expectedWatcher).length;
  return Array.from(map.values()).slice(0, Math.min(30, Math.max(12, ownedCount + 4)));
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
  if (tab.expectedWatcher) return 0;
  const kind = classifyStudioTab(tab);
  if (kind === "studio_channel") return 10;
  if (kind === "studio_other") return 20;
  return 30;
}

function scrapeTabKey(tab) {
  if (tab.scanKind === "youtube_bell_watcher") return `youtube_bell_watcher:${tab.id}`;
  if (tab.scanKind === "youtube_notifications" || isLikelyNotificationTab(tab)) return `youtube_notifications:${new URL(tab.url || "https://www.youtube.com").origin}`;
  if (tab.scanKind === "youtube_fallback") return `youtube_fallback:${tab.id}`;
  const url = String(tab.url || "");
  if (tab.expectedWatcher?.channelId) return `studio_channel:${tab.expectedWatcher.channelId}`;
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
    queued: Number(tab.queued || 0),
    duplicate: Number(tab.duplicate || 0),
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
      total.queued += Number(item.queued || 0);
      total.duplicate += Number(item.duplicate || 0);
      total.candidates += Number(item.candidates || 0);
      return total;
    },
    { tabs: 0, failed: 0, received: 0, matched: 0, unmatched: 0, ignored: 0, youtubeResolved: 0, queued: 0, duplicate: 0, candidates: 0 }
  );
}

function buildScanDiagnosis(results) {
  const totals = summarizeScanResults(results);
  const tabs = results.map((item) => ({ ...item, diagnostics: item.diagnostics || {} }));
  const menuOpened = tabs.filter((item) => item.diagnostics.menuOpened).length;
  const notificationButtons = tabs.filter((item) => item.diagnostics.notificationButtonFound).length;
  const visibleContainers = tabs.reduce((sum, item) => sum + Number(item.diagnostics.visibleNotificationContainers || 0), 0);
  const bodySnippetCount = tabs.reduce((sum, item) => sum + Number(item.diagnostics.bodySnippetCount || 0), 0);
  const rawWindowCount = tabs.reduce((sum, item) => sum + Number(item.diagnostics.rawWindowCount || 0), 0);
  const finishHintCount = tabs.reduce((sum, item) => sum + Number(item.diagnostics.finishHintCount || 0), 0);
  const buttonFoundButNotOpened = tabs.some((item) =>
    item.diagnostics.notificationButtonFound &&
    item.diagnostics.notificationOpenResult &&
    item.diagnostics.notificationOpenResult.opened === false
  );

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
      message: "The extension could not read any open Studio or YouTube tab.",
      action: "Reload the Studio or YouTube tabs, confirm Chrome extension permissions, then scan again."
    };
  }
  if (totals.candidates > 0 && totals.received === 0 && totals.ignored === 0) {
    if (totals.duplicate >= totals.candidates) {
      return {
        severity: "ok",
        code: "already_processed",
        message: "The extension saw A/B finish text that was already processed.",
        action: ""
      };
    }
    if (totals.queued > 0) {
      return {
        severity: "warn",
        code: "queued_for_retry",
        message: "The extension found A/B finish text but could not post it yet.",
        action: "The signal was saved locally and will retry automatically."
      };
    }
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
  if (totals.candidates > 0 && totals.ignored >= totals.candidates && totals.matched === 0 && totals.unmatched === 0) {
    return {
      severity: "warn",
      code: "only_non_finish_text",
      message: "The extension only found running-table or non-finish A/B text.",
      action: "Use Check now again after the YouTube bell opens, or keep YouTube home open so the bell menu can be read."
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
      message: buttonFoundButNotOpened
        ? "The extension found the YouTube bell button but could not open the notification list."
        : "Studio was open, but the extension could not open or see the notification list.",
      action: buttonFoundButNotOpened
        ? "Update to the newest extension and run Check now again. If it still misses, use I see a missed notification."
        : "Run Check now again. If it still misses visible text, use I see a missed notification."
    };
  }
  if (bodySnippetCount > 0 || rawWindowCount > 0 || finishHintCount > 0) {
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
    action: "Keep a Studio tab open and run Check now again. If it still misses visible text, use I see a missed notification."
  };
}

async function ensureContentScript(tabId) {
  const status = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => ({
        loaded: Boolean(globalThis.__youtubeAbTestsConnectorLoaded),
        version: String(globalThis.__youtubeAbTestsConnectorVersion || "")
      })
    })
    .then((results) => results?.[0]?.result || { loaded: false, version: "" })
    .catch(() => ({ loaded: false, version: "" }));
  if (status.loaded && status.version === EXTENSION_VERSION) return;
  if (status.loaded && status.version && status.version !== EXTENSION_VERSION) {
    const watcher = await ownedWatcherForTab(tabId);
    if (!watcher?.owned) {
      throw new Error("This user-owned tab still has an older extension script. Reload it manually or open the dedicated watcher tab.");
    }
    await chrome.tabs.reload(tabId).catch(() => {});
    await waitForTabReady(tabId, 8000).catch(() => {});
    await delay(700);
    const reloaded = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => String(globalThis.__youtubeAbTestsConnectorVersion || "")
      })
      .then((results) => results?.[0]?.result || "")
      .catch(() => "");
    if (reloaded === EXTENSION_VERSION) return;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  await delay(100);
}

async function waitForTabReady(tabId, timeoutMs = 5000) {
  if (!tabId) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === "complete") return;
    await delay(250);
  }
}

async function ensureAppBridge(tabId) {
  // Re-execution is intentional: app-bridge.js replaces its own listeners so a
  // Chrome extension reload cannot leave a stale website bridge behind.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["app-bridge.js"]
  });
  await delay(50);
  return { injected: true, refreshed: true };
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

function isAppBridgeUrl(url) {
  const value = String(url || "");
  return /^https:\/\/video-growth\.vercel\.app(?:\/|$)/i.test(value) ||
    /^http:\/\/127\.0\.0\.1:8770(?:\/|$)/i.test(value);
}

async function postEvents(events, tabUrl, options = {}) {
  if (!events.length) return { ok: true, received: 0 };
  const settings = await getSettings();
  requireConfigured(settings);
  await flushPendingEvents(settings).catch(() => null);
  const forcePost = Boolean(options.forcePost);
  // Manual checks may re-read old DOM rows, but they must never bypass the
  // durable duplicate guard. The server remains a second idempotency layer.
  const freshEvents = await filterDuplicateEvents(events);
  if (!freshEvents.length) {
    return { ok: true, received: 0, matched: 0, unmatched: 0, ignored: 0, duplicate: events.length };
  }
  const { response, payload } = await sendEventsBatch(settings, freshEvents, tabUrl, {
    channelScope: options.channelScope || [],
    testTypeScope: options.testTypeScope || "all"
  }).catch(async (error) => {
    await enqueuePendingEvents(freshEvents, tabUrl, error.message);
    await appendDiagnosticLog({
      category: "connector_events",
      severity: "warning",
      message: "Connector events queued for retry",
      context: { tabUrl, events: freshEvents.length, error: error.message }
    });
    return {
      response: { ok: true },
      payload: { ok: true, received: 0, matched: 0, unmatched: 0, ignored: 0, queued: freshEvents.length, error: error.message }
    };
  });
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
  if (!payload.queued) await rememberPostedEvents(freshEvents);
  await appendDiagnosticLog({
    category: "connector_events",
    severity: payload.queued ? "warning" : payload.matched ? "info" : "warning",
    message: "Connector events posted",
    context: {
      tabUrl,
      received: payload.received || freshEvents.length,
      matched: payload.matched || 0,
      unmatched: payload.unmatched || 0,
      ignored: payload.ignored || 0,
      youtubeResolved: payload.youtubeResolved || 0,
      queued: payload.queued || 0,
      duplicate: events.length - freshEvents.length,
      forcePost
      }
  });
  return { ...payload, duplicate: events.length - freshEvents.length };
}

async function sendEventsBatch(settings, events, tabUrl, options = {}) {
  const response = await fetchWithTimeout(`${cleanAppUrl(settings.appUrl)}/api/connector/events`, {
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
      channelScope: Array.isArray(options.channelScope) ? options.channelScope : [],
      testTypeScope: options.testTypeScope || "all",
      events
    })
  }, 20_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Connector event post failed: ${response.status}`);
  return { response, payload };
}

async function enqueuePendingEvents(events, tabUrl, reason = "") {
  const local = await chrome.storage.local.get([PENDING_EVENT_QUEUE_KEY]).catch(() => ({}));
  const current = Array.isArray(local[PENDING_EVENT_QUEUE_KEY]) ? local[PENDING_EVENT_QUEUE_KEY] : [];
  const pendingKeys = new Set(current.map((item) => eventKey(item.event || item)));
  const uniqueEvents = [];
  for (const event of events) {
    const key = eventKey(event);
    if (pendingKeys.has(key)) continue;
    pendingKeys.add(key);
    uniqueEvents.push(event);
  }
  const combined = [
    ...current,
    ...uniqueEvents.map((event) => ({
      event,
      tabUrl,
      reason,
      attempts: 0,
      queuedAt: new Date().toISOString(),
      lastTriedAt: "",
      nextAttemptAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + OUTBOX_TTL_MS).toISOString()
    }))
  ];
  const overflow = combined.slice(0, Math.max(0, combined.length - MAX_PENDING_EVENTS)).map((item) => ({
    ...item,
    deadAt: new Date().toISOString(),
    deadReason: "outbox_capacity_exceeded"
  }));
  if (overflow.length) await appendDeadEvents(overflow);
  const next = combined.slice(-MAX_PENDING_EVENTS);
  await chrome.storage.local.set({ [PENDING_EVENT_QUEUE_KEY]: next });
}

async function flushPendingEvents(settings = null) {
  const resolvedSettings = settings || await getSettings();
  requireConfigured(resolvedSettings);
  const local = await chrome.storage.local.get([PENDING_EVENT_QUEUE_KEY]).catch(() => ({}));
  const queue = Array.isArray(local[PENDING_EVENT_QUEUE_KEY]) ? local[PENDING_EVENT_QUEUE_KEY] : [];
  if (!queue.length) return { ok: true, flushed: 0, remaining: 0 };
  const fresh = [];
  const remaining = [];
  const expired = [];
  for (const item of queue) {
    const event = item.event || item;
    if (await isRecentDuplicate(event)) continue;
    if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) {
      expired.push({ ...item, deadAt: new Date().toISOString(), deadReason: "retry_expired" });
      continue;
    }
    if (!shouldRetryOutboxItem(item)) {
      remaining.push(item);
      continue;
    }
    fresh.push({ ...item, event });
  }
  if (expired.length) await appendDeadEvents(expired);
  if (!fresh.length) {
    await chrome.storage.local.set({ [PENDING_EVENT_QUEUE_KEY]: remaining });
    return { ok: true, flushed: 0, remaining: remaining.length, expired: expired.length };
  }
  try {
    const events = fresh.map((item) => item.event);
    await sendEventsBatch(resolvedSettings, events, "pending-retry");
    await rememberPostedEvents(events);
    await chrome.storage.local.set({ [PENDING_EVENT_QUEUE_KEY]: remaining });
    await appendDiagnosticLog({
      category: "connector_events",
      severity: "info",
      message: "Pending connector events retried successfully",
      context: { flushed: events.length, deferred: remaining.length, expired: expired.length }
    });
    return { ok: true, flushed: events.length, remaining: remaining.length, expired: expired.length };
  } catch (error) {
    const next = fresh.map((item) => ({
      ...item,
      attempts: Number(item.attempts || 0) + 1,
      lastTriedAt: new Date().toISOString(),
      nextAttemptAt: nextRetryAt(Number(item.attempts || 0) + 1),
      reason: error.message
    }));
    const combined = [...remaining, ...next].slice(-MAX_PENDING_EVENTS);
    await chrome.storage.local.set({ [PENDING_EVENT_QUEUE_KEY]: combined });
    return { ok: false, flushed: 0, remaining: combined.length, error: error.message };
  }
}

async function appendDeadEvents(items) {
  const local = await chrome.storage.local.get([DEAD_EVENT_QUEUE_KEY]).catch(() => ({}));
  const current = Array.isArray(local[DEAD_EVENT_QUEUE_KEY]) ? local[DEAD_EVENT_QUEUE_KEY] : [];
  await chrome.storage.local.set({ [DEAD_EVENT_QUEUE_KEY]: [...current, ...items].slice(-MAX_DEAD_EVENTS) });
}

async function filterDuplicateEvents(events) {
  const fresh = [];
  for (const event of events) {
    if (!(await isRecentDuplicate(event))) fresh.push(event);
  }
  return fresh;
}

async function isRecentDuplicate(event) {
  const key = eventKey(event);
  const recent = await readRecentEventKeys();
  const timestamp = Number(recent[key] || 0);
  return Boolean(timestamp && Date.now() - timestamp < RECENT_EVENT_TTL_MS);
}

async function rememberPostedEvents(events) {
  const recent = await readRecentEventKeys();
  const now = Date.now();
  for (const event of events) recent[eventKey(event)] = now;
  const pruned = Object.fromEntries(
    Object.entries(recent)
      .filter(([, timestamp]) => now - Number(timestamp || 0) < RECENT_EVENT_TTL_MS)
      .slice(-500)
  );
  await chrome.storage.local.set({ [RECENT_EVENT_KEYS_KEY]: pruned }).catch(() => {});
}

async function readRecentEventKeys() {
  const local = await chrome.storage.local.get([RECENT_EVENT_KEYS_KEY]).catch(() => ({}));
  return local[RECENT_EVENT_KEYS_KEY] && typeof local[RECENT_EVENT_KEYS_KEY] === "object"
    ? local[RECENT_EVENT_KEYS_KEY]
    : {};
}

function eventKey(event) {
  return stableEventKey(event);
}

function normalizeEventKeyText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 260);
}

async function openWatcherTabs(requestedTargets = [], options = {}) {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const watcherTabs = requestedTargets.length ? requestedTargets : config.watcherTabs || [];
  const unconfigured = watcherTabs.filter((target) => !target?.url);
  const targets = watcherTabs.filter((target) => target?.url);
  if (!targets.length) {
    const heartbeat = await sendHeartbeat().catch((error) => ({ ok: false, error: error.message }));
    return {
      ok: false,
      error: watcherTabs.length
        ? "Watcher channels are saved, but none has a Studio URL or UC channel ID yet. Add one on the website Extension page."
        : "No watcher channels are configured. Add one on the website Extension page.",
      opened: [],
      alreadyOpen: 0,
      totalTargets: 0,
      unconfigured: unconfigured.length,
      heartbeat,
      scan: null
    };
  }
  const ownedWatchers = await readOwnedWatchers();
  const targetsToOpen = options.onlyMissing
    ? targets.filter((target) => !ownedWatchers.some((watcher) => watcherMatchesTarget(watcher, target)))
    : targets;
  const opened = [];
  for (const target of targetsToOpen) {
    if (!target.url) continue;
    const tab = await chrome.tabs.create({ url: target.url, active: false });
    const watcher = watcherRecord(tab, target);
    opened.push(watcher);
    await saveOwnedWatcher(watcher);
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
    unconfigured: unconfigured.length,
    heartbeat,
    scan
  };
}

function watcherRecord(tab, target) {
  return {
    tabId: tab.id,
    label: target.label || target.url,
    url: target.url,
    channelId: String(target.url || "").match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "",
    owned: true,
    createdAt: new Date().toISOString()
  };
}

async function readOwnedWatchers() {
  const local = await chrome.storage.local.get([OWNED_WATCHERS_KEY]).catch(() => ({}));
  const stored = Array.isArray(local[OWNED_WATCHERS_KEY]) ? local[OWNED_WATCHERS_KEY] : [];
  const valid = [];
  for (const watcher of stored) {
    const tab = await chrome.tabs.get(watcher.tabId).catch(() => null);
    if (!tab?.id || !/^https:\/\/studio\.youtube\.com\//i.test(tab.url || "")) continue;
    valid.push({ ...watcher, currentUrl: tab.url || "" });
  }
  if (valid.length !== stored.length) await chrome.storage.local.set({ [OWNED_WATCHERS_KEY]: valid });
  return valid;
}

async function saveOwnedWatcher(watcher) {
  const current = await readOwnedWatchers();
  const next = current.filter((item) => item.tabId !== watcher.tabId && !watcherMatchesTarget(item, watcher));
  next.push(watcher);
  await chrome.storage.local.set({ [OWNED_WATCHERS_KEY]: next });
}

async function ownedWatcherForTab(tabId) {
  return (await readOwnedWatchers()).find((item) => item.tabId === tabId) || null;
}

function watcherMatchesTarget(watcher, target) {
  const watcherId = watcher.channelId || String(watcher.url || "").match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  const targetId = String(target.url || "").match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  if (watcherId && targetId) return watcherId === targetId;
  return Boolean(watcher.url && target.url && String(watcher.url).replace(/\/+$/, "") === String(target.url).replace(/\/+$/, ""));
}

function isWatcherTargetOpen(target, openStudioUrls) {
  const url = String(target?.url || "").replace(/\/+$/, "");
  const channelId = url.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  if (channelId) return openStudioUrls.some((item) => String(item).includes(channelId));
  return url ? openStudioUrls.some((item) => String(item).replace(/\/+$/, "").startsWith(url)) : false;
}

async function openNotificationPage({ active = true } = {}) {
  const existing = await getNotificationWatcherTab();
  if (existing?.id) {
    const update = isUnavailableNotificationUrl(existing.url) ? { active, url: NOTIFICATION_WATCHER_URL } : { active };
    const tab = await chrome.tabs.update(existing.id, update);
    await chrome.storage.local.set({ notificationWatcherTabId: existing.id });
    return { ok: true, reused: true, tabId: existing.id, url: tab.url || existing.url || NOTIFICATION_WATCHER_URL };
  }

  const youtubeTabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const reusable = youtubeTabs.find((tab) => !isUnavailableNotificationUrl(tab.url));
  if (reusable?.id) {
    await chrome.tabs.update(reusable.id, { active });
    await chrome.storage.local.set({ notificationWatcherTabId: reusable.id });
    return { ok: true, reused: true, tabId: reusable.id, url: reusable.url || NOTIFICATION_WATCHER_URL };
  }

  const created = await chrome.tabs.create({ url: NOTIFICATION_WATCHER_URL, active });
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
  const scan = await requestStudioScrapeGuarded({ userInitiated: true, avoidTabSwitch: true })
    .catch((error) => ({ ok: false, error: error.message }));
  const heartbeat = await sendHeartbeat({ userReportedMiss: true, lastStudioScan: await buildLastStudioScanPayload() })
    .catch((error) => ({ ok: false, error: error.message }));
  return { ok: scan.ok !== false, scan, heartbeat };
}

async function fetchConnectorConfig(settings) {
  const response = await fetchWithTimeout(`${cleanAppUrl(settings.appUrl)}/api/connector/config`, {
    headers: {
      "Authorization": `Bearer ${settings.connectorToken}`
    }
  }, 15_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Connector config failed: ${response.status}`);
  await chrome.storage.local.set({
    lastConnectorConfigAt: new Date().toISOString(),
    lastConnectorConfig: payload
  });
  await syncOwnedWatchersWithConfig(payload).catch(() => {});
  scheduleHourlyAlarm(payload.pollMinutes);
  scheduleCommandAlarm(payload.commandPollMinutes);
  return payload;
}

async function syncOwnedWatchersWithConfig(config = {}) {
  if (!config.configRevision || !Array.isArray(config.watcherTabs)) return;
  const local = await chrome.storage.local.get([OWNED_WATCHERS_KEY]).catch(() => ({}));
  const stored = Array.isArray(local[OWNED_WATCHERS_KEY]) ? local[OWNED_WATCHERS_KEY] : [];
  const targets = Array.isArray(config.watcherTabs) ? config.watcherTabs.filter((item) => item?.url) : [];
  const keep = [];
  for (const watcher of stored) {
    if (targets.some((target) => watcherMatchesTarget(watcher, target))) {
      keep.push(watcher);
      continue;
    }
    if (watcher.owned && watcher.tabId) await chrome.tabs.remove(watcher.tabId).catch(() => {});
  }
  if (keep.length !== stored.length) {
    await chrome.storage.local.set({
      [OWNED_WATCHERS_KEY]: keep,
      watcherConfigRevision: config.configRevision || ""
    });
  }
}

async function deepScanActiveVideos(options = {}) {
  const settings = await getSettings();
  requireConfigured(settings);
  const config = await fetchConnectorConfig(settings);
  const activeTests = Array.isArray(config.activeTests) ? config.activeTests : [];
  const limit = Math.max(1, Math.min(DEEP_SCAN_LIMIT, Number(options.limit || DEEP_SCAN_LIMIT)));
  const targets = uniqueStudioTargets(activeTests).slice(0, limit);
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
    limit,
    reason: options.reason || "",
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
  const remoteConfig = await fetchConnectorConfig(settings).catch(() => null);
  const reportedChannels = Array.isArray(remoteConfig?.channels) && remoteConfig.channels.length
    ? remoteConfig.channels
    : splitChannels(settings.channels);
  if (remoteConfig?.channels?.length) {
    await chrome.storage.sync.set({ channels: remoteConfig.channels.join(", ") }).catch(() => {});
  }
  const pendingFlush = await flushPendingEvents(settings).catch((error) => ({ ok: false, error: error.message }));
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
  const youtubeTabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const notificationWatcherTab = await getNotificationWatcherTab();
  const studioTabDetails = await collectStudioTabDetails(studioTabs);
  const pendingState = await pendingQueueState();
  const ownedWatchers = await readOwnedWatchers();
  const selfTest = buildQuietSelfTest({
    settings,
    studioTabs,
    youtubeTabs,
    notificationWatcherTab,
    appBridge,
    pendingState,
    pendingFlush
  });
  const lastStudioScan = extraPayload.lastStudioScan === undefined
    ? await buildLastStudioScanPayload()
    : extraPayload.lastStudioScan;
  const heartbeatPayload = {
    location: "chrome-extension",
    openStudioTabs: studioTabs.length,
    openYoutubeTabs: youtubeTabs.length,
    studioTabUrls: studioTabs.map((tab) => tab.url || "").filter(Boolean).slice(0, 10),
    notificationWatcherOpen: Boolean(notificationWatcherTab),
    notificationWatcherUrl: notificationWatcherTab?.url || "",
    studioTabs: studioTabDetails.slice(0, 10),
    appBridge,
    pendingQueue: pendingState,
    pendingFlush,
    selfTest,
    userAgent: navigator.userAgent,
    capabilities: EXTENSION_CAPABILITIES,
    ownedWatchers: ownedWatchers.map((item) => ({
      tabId: item.tabId,
      label: item.label,
      channelId: item.channelId,
      url: item.url
    })),
    runtimeConfigVersion: (await cachedRuntimeConfig())?.version || "",
    observedAt: new Date().toISOString(),
    diagnosticLog: await readDiagnosticLog(),
    ...extraPayload,
    lastStudioScan
  };
  const response = await fetchWithTimeout(`${cleanAppUrl(settings.appUrl)}/api/connector/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.connectorToken}`
    },
    body: JSON.stringify({
      connectorId: settings.connectorId,
      actorName: settings.actorName,
      version: EXTENSION_VERSION,
      channels: reportedChannels,
      status: "online",
      capabilities: EXTENSION_CAPABILITIES,
      ...heartbeatPayload
    })
  }, 20_000);
  const responsePayload = await response.json().catch(() => ({}));
  if (response.ok && responsePayload.connectorId && responsePayload.connectorId !== settings.connectorId) {
    await chrome.storage.sync.set({ connectorId: responsePayload.connectorId }).catch(() => {});
  }
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

async function pendingQueueState() {
  const local = await chrome.storage.local.get([PENDING_EVENT_QUEUE_KEY, DEAD_EVENT_QUEUE_KEY]).catch(() => ({}));
  const queue = Array.isArray(local[PENDING_EVENT_QUEUE_KEY]) ? local[PENDING_EVENT_QUEUE_KEY] : [];
  const dead = Array.isArray(local[DEAD_EVENT_QUEUE_KEY]) ? local[DEAD_EVENT_QUEUE_KEY] : [];
  return {
    count: queue.length,
    deadCount: dead.length,
    oldestQueuedAt: queue[0]?.queuedAt || "",
    newestQueuedAt: queue[queue.length - 1]?.queuedAt || "",
    maxAttempts: queue.reduce((max, item) => Math.max(max, Number(item.attempts || 0)), 0)
  };
}

function buildQuietSelfTest({ settings, studioTabs, youtubeTabs, notificationWatcherTab, appBridge, pendingState, pendingFlush }) {
  const issues = [];
  if (!settings.appUrl) issues.push("missing_app_url");
  if (!settings.connectorToken) issues.push("missing_connector_token");
  if (!studioTabs.length) issues.push("no_studio_tabs");
  if (!youtubeTabs.length) issues.push("no_youtube_tabs");
  if (!notificationWatcherTab) issues.push("no_youtube_watcher");
  if (appBridge?.ok === false || Number(appBridge?.failed || 0) > 0) issues.push("dashboard_bridge_failed");
  if (Number(pendingState?.count || 0) > 0) issues.push("pending_events");
  if (pendingFlush?.ok === false) issues.push("pending_retry_failed");
  return {
    ok: issues.length === 0,
    issues,
    checkedAt: new Date().toISOString()
  };
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
      rawWindowCount: 0,
      finishHintCount: 0,
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
      pageIdentity: status?.pageIdentity || null,
      visibleNotificationContainers: Number(status?.visibleNotificationContainers || 0),
        bodySnippetCount: Number(status?.bodySnippetCount || 0),
        rawWindowCount: Number(status?.rawWindowCount || 0),
        finishHintCount: Number(status?.finishHintCount || 0)
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
          ignored: Number(tab.ignored || 0),
          candidates: Number(tab.candidates || 0),
          queued: Number(tab.queued || 0),
          duplicate: Number(tab.duplicate || 0),
          menuOpened: Boolean(tab.diagnostics?.menuOpened),
          channel: tab.diagnostics?.channel || "",
          channelId: tab.diagnostics?.channelId || "",
          rawWindowCount: Number(tab.diagnostics?.rawWindowCount || 0),
          finishHintCount: Number(tab.diagnostics?.finishHintCount || 0),
          accessibleNotificationCount: Number(tab.diagnostics?.accessibleNotificationCount || 0),
          debugSample: tab.diagnostics?.debugSample || "",
          notificationOpenResult: tab.diagnostics?.notificationOpenResult || null,
          pageIdentity: tab.diagnostics?.pageIdentity || null,
          previews: Array.isArray(tab.previews) ? tab.previews.slice(0, 3) : []
        }))
      : [],
    scope: result.scope || null,
    runtimeConfigVersion: result.runtimeConfigVersion || "",
    diagnosis: sanitizeDiagnosis(result.diagnosis)
  };
}

async function runtimeConfigForScan() {
  const settings = await getSettings().catch(() => null);
  if (!settings?.appUrl || !settings?.connectorToken) {
    return normalizeRuntimeConfig((await cachedRuntimeConfig()) || DEFAULT_RUNTIME_CONFIG);
  }
  try {
    const payload = await fetchRuntimeConfig(settings);
    const runtimeConfig = normalizeRuntimeConfig(payload.runtimeConfig || {});
    await chrome.storage.local.set({
      [RUNTIME_CONFIG_STORAGE_KEY]: runtimeConfig,
      lastRuntimeConfigAt: new Date().toISOString(),
      lastRuntimeConfigOk: true,
      lastRuntimeConfigError: ""
    });
    return runtimeConfig;
  } catch (error) {
    await chrome.storage.local.set({
      lastRuntimeConfigAt: new Date().toISOString(),
      lastRuntimeConfigOk: false,
      lastRuntimeConfigError: error.message || "Runtime config fetch failed"
    }).catch(() => {});
    return normalizeRuntimeConfig((await cachedRuntimeConfig()) || DEFAULT_RUNTIME_CONFIG);
  }
}

async function fetchRuntimeConfig(settings) {
  const response = await fetchWithTimeout(`${cleanAppUrl(settings.appUrl)}/api/connector/runtime-config`, {
    headers: {
      "Authorization": `Bearer ${settings.connectorToken}`
    }
  }, 15_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Runtime config failed: ${response.status}`);
  return payload;
}

async function cachedRuntimeConfig() {
  const local = await chrome.storage.local.get([RUNTIME_CONFIG_STORAGE_KEY]).catch(() => ({}));
  return local[RUNTIME_CONFIG_STORAGE_KEY] || null;
}

function normalizeRuntimeConfig(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...input,
    passiveScanMinutes: clampRuntimeNumber(input.passiveScanMinutes, 15, 240, DEFAULT_RUNTIME_CONFIG.passiveScanMinutes),
    commandPollMinutes: clampRuntimeNumber(input.commandPollMinutes, 1, 15, DEFAULT_RUNTIME_CONFIG.commandPollMinutes),
    startupCatchupMinutes: clampRuntimeNumber(input.startupCatchupMinutes, 5, 120, DEFAULT_RUNTIME_CONFIG.startupCatchupMinutes),
    waitAfterOpenMs: clampRuntimeNumber(input.waitAfterOpenMs, 300, 6000, DEFAULT_RUNTIME_CONFIG.waitAfterOpenMs),
    waitForRowsMs: clampRuntimeNumber(input.waitForRowsMs, 1000, 12000, DEFAULT_RUNTIME_CONFIG.waitForRowsMs),
    scrollRounds: clampRuntimeNumber(input.scrollRounds, 0, 8, DEFAULT_RUNTIME_CONFIG.scrollRounds),
    scrollDelayMs: clampRuntimeNumber(input.scrollDelayMs, 150, 3000, DEFAULT_RUNTIME_CONFIG.scrollDelayMs),
    minTextLength: clampRuntimeNumber(input.minTextLength, 8, 120, DEFAULT_RUNTIME_CONFIG.minTextLength),
    maxTextLength: clampRuntimeNumber(input.maxTextLength, 140, 2000, DEFAULT_RUNTIME_CONFIG.maxTextLength),
    maxEvents: clampRuntimeNumber(input.maxEvents, 5, 120, DEFAULT_RUNTIME_CONFIG.maxEvents),
    scanOrder: input.scanOrder === "studio_first" ? "studio_first" : "youtube_first",
    openYoutubeFallback: input.openYoutubeFallback === true,
    deepScanFallbackEnabled: input.deepScanFallbackEnabled === true,
    includeSeenOnManualScan: input.includeSeenOnManualScan !== false,
    accessibleLabelsEnabled: input.accessibleLabelsEnabled !== false,
    notificationSelectors: mergeRuntimeSelectors(input.notificationSelectors, 48),
    notificationButtonSelectors: mergeRuntimeSelectors(input.notificationButtonSelectors, 48),
    notificationSurfaceSelectors: mergeRuntimeSelectors(input.notificationSurfaceSelectors, 32),
    finishPhrases: mergeRuntimePhrases(DEFAULT_RUNTIME_CONFIG.finishPhrases, input.finishPhrases, 80),
    ignorePhrases: mergeRuntimePhrases(DEFAULT_RUNTIME_CONFIG.ignorePhrases, input.ignorePhrases, 100)
  };
}

function mergeRuntimeSelectors(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= 2 && item.length <= 180)
    .filter((item) => !/[{};<>]/.test(item))))
    .slice(0, maxItems);
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

function clampRuntimeNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
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
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS)),
    chrome.storage.local.get(["connectorToken"])
  ]);
  if (sync.connectorToken) {
    if (!local.connectorToken) await chrome.storage.local.set({ connectorToken: sync.connectorToken });
    await chrome.storage.sync.remove("connectorToken");
  }
  return {
    ...DEFAULT_SETTINGS,
    ...sync,
    connectorToken: local.connectorToken || sync.connectorToken || ""
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
