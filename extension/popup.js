let autoConnectionChecked = false;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("versionBadge").textContent = `v${chrome.runtime.getManifest().version}`;
  await render();
  document.getElementById("smartStart").addEventListener("click", async () => {
    await runPrimaryAction();
  });
  document.getElementById("openWatchers").addEventListener("click", async () => {
    await openWatcherTargets([], "Opening missing Studio watcher tabs...");
  });
  document.getElementById("scan").addEventListener("click", async () => {
    setSummary("Scanning open Studio tabs and the YouTube bell menu...");
    const response = await chrome.runtime.sendMessage({ type: "scan-studio-tab" });
    setSummary(scanResultText(response));
    await render();
    setSummary(scanResultText(response));
  });
  document.getElementById("openNotifications").addEventListener("click", async () => {
    setSummary("Opening or reusing YouTube home for a bell check...");
    const response = await chrome.runtime.sendMessage({ type: "open-notification-page" });
    setSummary(response?.ok ? (response.reused ? "YouTube home is already open for bell checks." : "YouTube home opened. Open the bell menu if needed, then run Check now.") : response?.error || "Could not open YouTube home.");
    await render();
  });
  document.getElementById("deepScan").addEventListener("click", async () => {
    setSummary("Checking up to 8 active test pages. Read-only; no YouTube changes.");
    const response = await chrome.runtime.sendMessage({ type: "deep-scan-active-videos" });
    setSummary(deepScanResultText(response));
    await render();
    setSummary(deepScanResultText(response));
  });
  document.getElementById("heartbeat").addEventListener("click", async () => {
    setSummary("Checking dashboard connection...");
    const response = await chrome.runtime.sendMessage({ type: "send-heartbeat" });
    setSummary(connectionResultText(response));
    await render();
    setSummary(connectionResultText(response));
  });
  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
});

async function render() {
  const sync = await chrome.storage.sync.get(["appUrl", "actorName", "channels"]);
  const local = await chrome.storage.local.get([
    "lastHeartbeatAt",
    "lastHeartbeatOk",
    "lastHeartbeatResult",
    "lastEventPostAt",
    "lastEventPostOk",
    "lastEventPostResult",
    "lastDeepScanAt",
    "lastDeepScanResult",
    "lastStudioScanAt",
    "lastStudioScanResult"
  ]);
  const connectorConfig = await chrome.runtime
    .sendMessage({ type: "get-connector-config" })
    .catch((error) => ({ ok: false, error: error.message }));
  const latestHeartbeat = latestOwnHeartbeat(local.lastHeartbeatResult, sync.actorName);
  const openStudioTabs = Number(latestHeartbeat?.payload?.openStudioTabs || 0);
  const openStudioUrls = latestHeartbeat?.payload?.studioTabUrls || [];
  renderWatcherButtons(connectorConfig?.watcherTabs || [], openStudioUrls, connectorConfig);
  renderScanLog(local.lastStudioScanAt, local.lastStudioScanResult);
  const watchState = buildWatchState({ sync, local, connectorConfig, openStudioTabs, openStudioUrls });
  renderHealthPanel(watchState);
  renderPrimaryAction(watchState);
  if (!sync.appUrl) {
    setSummary("Open Settings to connect this watcher to the dashboard.");
  } else if (local.lastHeartbeatOk && openStudioTabs === 0) {
    setSummary("Connected, but not watching. Open watcher tabs before expecting live detection.");
  } else if (connectorConfig && connectorConfig.ok === false) {
    setSummary(connectorConfig.error || "Dashboard settings could not be loaded.");
  } else {
    setSummary(`Connected to ${sync.appUrl}. Watching works when Studio tabs stay open.`);
  }
  document.getElementById("lastHeartbeat").textContent = local.lastHeartbeatAt
    ? `${formatTime(local.lastHeartbeatAt)} (${local.lastHeartbeatOk ? "ok" : "failed"}${local.lastHeartbeatOk ? `, ${openStudioTabs} Studio tab${openStudioTabs === 1 ? "" : "s"}` : ""})`
    : "Never";
  document.getElementById("lastEvent").textContent = local.lastEventPostAt
    ? `${formatTime(local.lastEventPostAt)} (${local.lastEventPostOk ? "ok" : "failed"})`
    : "Never";
  maybeAutoCheckConnection({ sync, local, connectorConfig });
}

async function runPrimaryAction() {
  const button = document.getElementById("smartStart");
  const action = button?.dataset.action || "smart-start";
  if (action === "settings") {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (action === "scan") {
    setSummary("Scanning open Studio tabs and the YouTube bell menu...");
    const response = await chrome.runtime.sendMessage({ type: "scan-studio-tab" });
    setSummary(scanResultText(response));
    await render();
    setSummary(scanResultText(response));
    return;
  }
  setSummary("Opening missing watcher tabs, checking connection, then scanning...");
  const response = await chrome.runtime.sendMessage({ type: "smart-start-watching" });
  setSummary(smartStartResultText(response));
  await render();
  setSummary(smartStartResultText(response));
}

async function maybeAutoCheckConnection({ sync, local, connectorConfig }) {
  if (autoConnectionChecked) return;
  if (!sync.appUrl || connectorConfig?.ok === false) return;
  const lastChecked = local.lastHeartbeatAt ? new Date(local.lastHeartbeatAt).getTime() : 0;
  const stale = !lastChecked || Date.now() - lastChecked > 10 * 60 * 1000;
  if (!stale) return;
  autoConnectionChecked = true;
  chrome.runtime
    .sendMessage({ type: "send-heartbeat" })
    .then(() => render())
    .catch(() => {});
}

function renderScanLog(scanAt, result) {
  const summaryEl = document.getElementById("scanLogSummary");
  const bodyEl = document.getElementById("scanLogBody");
  if (!summaryEl || !bodyEl) return;
  const totals = result?.totals || {};
  const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
  if (!scanAt || !tabs.length) {
    summaryEl.textContent = "No scan yet";
    bodyEl.innerHTML = `<p class="muted">Click Check now to create a diagnostic log.</p>`;
    return;
  }
  summaryEl.textContent = `${totals.tabs || tabs.length} tab${(totals.tabs || tabs.length) === 1 ? "" : "s"}, ${totals.candidates || 0} candidate${Number(totals.candidates || 0) === 1 ? "" : "s"}`;
  const diagnosis = result?.diagnosis;
  const diagnosisHtml = diagnosis && diagnosis.severity !== "ok"
    ? `<p class="mini-warning">${escapeHtml(diagnosis.message)}${diagnosis.action ? ` ${escapeHtml(diagnosis.action)}` : ""}</p>`
    : "";
  bodyEl.innerHTML = [
    `<p class="scan-log-time">Checked ${escapeHtml(formatTime(scanAt))}. Sent ${Number(totals.received || 0)} signal${Number(totals.received || 0) === 1 ? "" : "s"}: ${Number(totals.matched || 0)} matched, ${Number(totals.unmatched || 0)} unmatched.</p>`,
    diagnosisHtml,
    ...tabs.slice(0, 6).map(renderScanLogTab)
  ].join("");
}

function renderScanLogTab(tab) {
  const diagnostics = tab.diagnostics || {};
  const status = tab.ok ? "ok" : "failed";
  const title = tab.tabTitle || diagnostics.channel || tab.tabUrl || `Tab ${tab.tabId}`;
  const preview = Array.isArray(tab.previews) && tab.previews.length
    ? `<ul>${tab.previews.map((item) => `<li>${escapeHtml(item.title || item.videoId || item.text || "A/B notification")}</li>`).join("")}</ul>`
    : `<p class="muted">No A/B finish notification candidates found.</p>`;
  return `
    <section class="scan-log-tab ${status}">
      <strong>${escapeHtml(title)}</strong>
      <span>${diagnostics.menuOpened ? "Notification menu opened" : "Menu not found/opened"} · ${Number(tab.candidates || 0)} candidate${Number(tab.candidates || 0) === 1 ? "" : "s"} · ${Number(tab.matched || 0)} matched</span>
      ${tab.error ? `<p class="mini-warning">${escapeHtml(tab.error)}</p>` : preview}
    </section>
  `;
}

function buildWatchState({ sync, local, connectorConfig, openStudioTabs, openStudioUrls }) {
  const watcherTabs = connectorConfig?.watcherTabs || [];
  const openWatchers = watcherTabs.filter((target) => isWatcherOpen(target, openStudioUrls));
  const missingWatchers = watcherTabs.filter((target) => !isWatcherOpen(target, openStudioUrls));
  const anyConfiguredWatcherOpen = openWatchers.length > 0;
  let state = {
    tone: "neutral",
    title: "Watching status unknown",
    text: "Open watcher tabs, then check the connection.",
    action: "smart-start",
    actionLabel: "Start watching + check",
    actionHint: "Opens missing Studio watcher tabs, checks the dashboard connection, then scans once.",
    watcherTabs,
    openWatchers,
    missingWatchers,
    openStudioTabs
  };

  if (!sync.appUrl) {
    state = {
      ...state,
      tone: "warn",
      title: "Setup needed",
      text: "Open Settings and add the app URL plus extension token.",
      action: "settings",
      actionLabel: "Open Settings",
      actionHint: "Connect the extension to the dashboard before scanning."
    };
  } else if (connectorConfig?.ok === false) {
    state = {
      ...state,
      tone: "warn",
      title: "Cannot reach dashboard",
      text: connectorConfig.error || "Check the extension token.",
      action: "settings",
      actionLabel: "Fix Settings",
      actionHint: "The dashboard rejected the extension config. Check app URL and token."
    };
  } else if (!watcherTabs.length) {
    state = {
      ...state,
      tone: "warn",
      title: "No watcher channels",
      text: "Add watched channels in the dashboard Extension settings.",
      action: "settings",
      actionLabel: "Open Settings",
      actionHint: "Configure Jotform, AI Agents Podcast, AI Agents, or any other channel before relying on passive detection."
    };
  } else if (!local.lastHeartbeatAt) {
    state = {
      ...state,
      tone: "warn",
      title: "Not checked yet",
      text: "Open watcher tabs, then click Start watching.",
      actionHint: "One click opens missing watcher tabs, checks connection, then scans."
    };
  } else if (openStudioTabs === 0) {
    state = {
      ...state,
      tone: "warn",
      title: "No Studio tab open",
      text: "Open at least one watcher tab before relying on live detection.",
      actionHint: "Opens the configured Studio channels in background tabs, then checks for finish signals."
    };
  } else if (watcherTabs.length && !anyConfiguredWatcherOpen) {
    state = {
      ...state,
      tone: "warn",
      title: "Wrong Studio tab open",
      text: "A Studio tab is open, but not a configured watcher channel.",
      actionHint: "Keeps your existing tabs and opens only the missing configured watcher channels."
    };
  } else if (missingWatchers.length) {
    const names = missingWatchers.map((item) => item.label || "Studio").slice(0, 2).join(", ");
    state = {
      ...state,
      tone: "warn",
      title: `${missingWatchers.length} watcher${missingWatchers.length === 1 ? "" : "s"} missing`,
      text: `Open ${names}${missingWatchers.length > 2 ? "..." : ""}.`,
      actionHint: "Opens only the missing watcher channels and scans after they load."
    };
  } else {
    state = {
      ...state,
      tone: "ok",
      title: `Watching ${openWatchers.length || openStudioTabs} Studio tab${(openWatchers.length || openStudioTabs) === 1 ? "" : "s"}`,
      text: "Passive checks run hourly. Use Check now when you want an immediate scan.",
      action: "scan",
      actionLabel: "Check now",
      actionHint: "Watcher tabs are open. Scan visible Studio notifications now."
    };
  }
  return state;
}

function renderHealthPanel(state) {
  const health = document.getElementById("healthPanel");
  const title = document.getElementById("healthTitle");
  const text = document.getElementById("healthText");
  health.className = `health-panel ${state.tone}`;
  title.textContent = state.title;
  text.textContent = state.text;
}

function renderPrimaryAction(state) {
  const title = document.getElementById("primaryTitle");
  const hint = document.getElementById("primaryHint");
  const button = document.getElementById("smartStart");
  if (!title || !hint || !button) return;
  title.textContent = state.action === "scan" ? "Ready for real-signal check" : "Next best action";
  hint.textContent = state.actionHint;
  button.textContent = state.actionLabel;
  button.dataset.action = state.action;
  button.className = state.action === "settings" ? "secondary-action" : "";
}

async function openWatcherTargets(targets, loadingText) {
  setSummary(loadingText);
  const response = await chrome.runtime.sendMessage({ type: "open-watcher-tabs", targets, onlyMissing: true });
  if (!response?.ok) {
    setSummary(response?.error || "Could not open watcher tabs.");
    return;
  }
  const count = response.opened?.length || 0;
  const alreadyOpen = Number(response.alreadyOpen || 0);
  const heartbeatText = response.heartbeat?.ok === false ? " Connection check failed." : " Connection checked.";
  const scanText = response.scan?.ok === false ? " Scan could not run yet." : response.scan ? ` ${shortScanResultText(response.scan)}` : "";
  const openText = count
    ? `Opened ${count} missing watcher tab${count === 1 ? "" : "s"}`
    : alreadyOpen
      ? `${alreadyOpen} watcher tab${alreadyOpen === 1 ? " is" : "s are"} already open`
      : "No watcher tabs needed";
  const doneText = `${openText}.${heartbeatText}${scanText}`;
  await render();
  setSummary(doneText);
}

function renderWatcherButtons(watcherTabs, openStudioUrls, connectorConfig) {
  const container = document.getElementById("watcherButtons");
  const count = document.getElementById("watcherCount");
  container.innerHTML = "";
  if (connectorConfig?.ok === false) {
    count.textContent = "Not connected";
    container.innerHTML = `<p class="mini-warning">${escapeHtml(connectorConfig.error || "Open Settings and save the connector token.")}</p>`;
    return;
  }
  if (!watcherTabs.length) {
    count.textContent = "None";
    container.innerHTML = `<p class="mini-warning">Add watcher channels in the website Settings page first.</p>`;
    return;
  }
  count.textContent = `${watcherTabs.length} configured`;
  watcherTabs.forEach((target) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `watcher-button ${isWatcherOpen(target, openStudioUrls) ? "open" : ""}`;
    button.innerHTML = `<span>${escapeHtml(target.label || "Studio")}</span><em>${isWatcherOpen(target, openStudioUrls) ? "open" : "not open"}</em>`;
    button.addEventListener("click", async () => {
      await openWatcherTargets([target], `Opening ${target.label || "Studio"} watcher tab...`);
    });
    container.appendChild(button);
  });
}

function setSummary(text) {
  document.getElementById("summary").textContent = text;
}

function smartStartResultText(response) {
  if (!response?.ok) return response?.error || "Could not start watching.";
  const opened = Number(response.opened?.length || 0);
  const alreadyOpen = Number(response.alreadyOpen || 0);
  const openText = opened
    ? `Opened ${opened} missing watcher tab${opened === 1 ? "" : "s"}`
    : alreadyOpen
      ? `${alreadyOpen} watcher tab${alreadyOpen === 1 ? " is" : "s are"} already open`
      : "No watcher tabs were opened";
  const connectionText = response.heartbeat?.ok === false
    ? "Dashboard connection failed."
    : "Dashboard connection checked.";
  const scanText = response.scan?.ok === false
    ? " Scan could not finish."
    : response.scan
      ? ` ${shortScanResultText(response.scan)}`
      : "";
  return `${openText}. ${connectionText}${scanText}`;
}

function scanResultText(response) {
  if (!response?.ok) return response?.error || "Scan failed.";
  const summary = summarizeScrapeTabs(response.tabs || []);
  const diagnosis = response.diagnosis || buildPopupDiagnosis(response.tabs || []);
  const diagnosisSuffix = diagnosis?.severity && diagnosis.severity !== "ok"
    ? ` ${diagnosis.message}${diagnosis.action ? ` ${diagnosis.action}` : ""}`
    : "";
  if (!summary.checked) {
    return "No Studio or YouTube bell tabs are open. Open watcher tabs or YouTube home, then scan again.";
  }
  if (!summary.received) {
    const failedText = summary.failed ? ` ${summary.failed} tab${summary.failed === 1 ? "" : "s"} could not be read.` : "";
    return `Checked ${summary.checked} tab${summary.checked === 1 ? "" : "s"}. No finish notifications found.${failedText}${diagnosisSuffix}`;
  }
  const ignoredText = summary.ignored ? `, ${summary.ignored} ignored` : "";
  const failedText = summary.failed ? `. ${summary.failed} tab${summary.failed === 1 ? "" : "s"} could not be read` : "";
  return `Checked ${summary.checked} tab${summary.checked === 1 ? "" : "s"}. Sent ${summary.received} finish signal${summary.received === 1 ? "" : "s"}: ${summary.matched} matched, ${summary.unmatched} unmatched${ignoredText}${failedText}.`;
}

function shortScanResultText(response) {
  const summary = summarizeScrapeTabs(response?.tabs || []);
  if (!summary.checked) return "No Studio or YouTube bell tabs were found.";
  const diagnosis = response?.diagnosis || buildPopupDiagnosis(response?.tabs || []);
  const diagnosisSuffix = diagnosis?.severity && diagnosis.severity !== "ok"
    ? ` ${diagnosis.message}`
    : "";
  if (!summary.received) return `Checked ${summary.checked} tab${summary.checked === 1 ? "" : "s"}; no finish notifications found.${diagnosisSuffix}`;
  return `Sent ${summary.received} finish signal${summary.received === 1 ? "" : "s"}.`;
}

function deepScanResultText(response) {
  if (!response?.ok) return response?.error || "Check active tests failed.";
  const scanned = Number(response.scanned || 0);
  const opened = Number(response.opened || 0);
  const received = Number(response.received || 0);
  const candidates = Number(response.candidates || 0);
  if (!candidates) return "No active tests were available from the dashboard.";
  if (!opened) return "Could not open active test pages. Check Chrome tab permissions.";
  if (!received) {
    return `Checked ${scanned} active test page${scanned === 1 ? "" : "s"}. No finish notifications found.`;
  }
  return `Checked ${scanned} active test page${scanned === 1 ? "" : "s"}. Sent ${received} finish signal${received === 1 ? "" : "s"}.`;
}

function connectionResultText(response) {
  if (!response?.ok) return response?.error || "Connection check failed.";
  const status = normalizeConnectorStatuses(response.connectorStatus)[0];
  const openTabs = Number(status?.payload?.openStudioTabs || 0);
  if (!openTabs) return "Connection checked. Dashboard is reachable, but no Studio tabs are open.";
  return `Connection checked. Dashboard is reachable and ${openTabs} Studio tab${openTabs === 1 ? " is" : "s are"} open.`;
}

function summarizeScrapeTabs(tabs) {
  return tabs.reduce(
    (summary, tab) => {
      summary.checked += 1;
      if (tab?.ok === false) summary.failed += 1;
      summary.received += Number(tab?.received || 0);
      summary.matched += Number(tab?.matched || 0);
      summary.unmatched += Number(tab?.unmatched || 0);
      summary.ignored += Number(tab?.ignored || 0);
      return summary;
    },
    { checked: 0, failed: 0, received: 0, matched: 0, unmatched: 0, ignored: 0 }
  );
}

function buildPopupDiagnosis(tabs = []) {
  const summary = summarizeScrapeTabs(tabs);
  const diagnostics = tabs.map((tab) => tab?.diagnostics || {});
  const menuOpened = diagnostics.filter((item) => item.menuOpened).length;
  const notificationButtons = diagnostics.filter((item) => item.notificationButtonFound).length;
  const visibleContainers = diagnostics.reduce((sum, item) => sum + Number(item.visibleNotificationContainers || 0), 0);
  const bodySnippetCount = diagnostics.reduce((sum, item) => sum + Number(item.bodySnippetCount || 0), 0);
  if (!summary.checked) {
    return { severity: "warn", message: "No Studio or YouTube bell tabs were open.", action: "Open watcher tabs or YouTube home first." };
  }
  if (summary.failed >= summary.checked) {
    return { severity: "warn", message: "The extension could not read any Studio tab.", action: "Reload Studio and scan again." };
  }
  if (summary.received) return { severity: "ok", message: "Signals sent.", action: "" };
  if (!notificationButtons) {
    return { severity: "warn", message: "No Studio notification button was found.", action: "Open the normal Studio channel page." };
  }
  if (!menuOpened && !visibleContainers) {
    return { severity: "warn", message: "The notification list was not visible.", action: "Open the bell panel manually and scan again." };
  }
  if (bodySnippetCount > 0) {
    return { severity: "warn", message: "A/B-looking text was visible but not sent.", action: "This may be a parser issue." };
  }
  return { severity: "info", message: "No A/B finish text was visible.", action: "Open the bell panel if you can see notifications." };
}

function formatTime(value) {
  return new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function latestOwnHeartbeat(result, actorName) {
  const statuses = normalizeConnectorStatuses(result?.connectorStatus);
  if (!statuses.length) return null;
  if (!actorName) return statuses[0];
  return statuses.find((item) => item.actorName === actorName) || statuses[0];
}

function normalizeConnectorStatuses(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function isWatcherOpen(target, openStudioUrls) {
  const url = String(target?.url || "").replace(/\/+$/, "");
  const channelId = url.match(/(UC[A-Za-z0-9_-]{10,})/)?.[1] || "";
  if (channelId) return openStudioUrls.some((item) => String(item).includes(channelId));
  return url ? openStudioUrls.some((item) => String(item).replace(/\/+$/, "").startsWith(url)) : false;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    const escapes = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return escapes[char];
  });
}
