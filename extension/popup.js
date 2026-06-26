document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("versionBadge").textContent = `v${chrome.runtime.getManifest().version}`;
  await render();
  document.getElementById("openWatchers").addEventListener("click", async () => {
    await openWatcherTargets([], "Opening all configured Studio watcher tabs...");
  });
  document.getElementById("scan").addEventListener("click", async () => {
    setSummary("Scanning open Studio tabs...");
    const response = await chrome.runtime.sendMessage({ type: "scan-studio-tab" });
    setSummary(response?.ok ? "Scan request sent." : response?.error || "Scan failed.");
    await render();
  });
  document.getElementById("heartbeat").addEventListener("click", async () => {
    setSummary("Sending heartbeat...");
    const response = await chrome.runtime.sendMessage({ type: "send-heartbeat" });
    setSummary(response?.ok ? "Heartbeat sent." : response?.error || "Heartbeat failed.");
    await render();
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
    "lastEventPostResult"
  ]);
  const connectorConfig = await chrome.runtime
    .sendMessage({ type: "get-connector-config" })
    .catch((error) => ({ ok: false, error: error.message }));
  const latestHeartbeat = latestOwnHeartbeat(local.lastHeartbeatResult, sync.actorName);
  const openStudioTabs = Number(latestHeartbeat?.payload?.openStudioTabs || 0);
  const openStudioUrls = latestHeartbeat?.payload?.studioTabUrls || [];
  renderWatcherButtons(connectorConfig?.watcherTabs || [], openStudioUrls, connectorConfig);
  if (!sync.appUrl) {
    setSummary("Open Settings to connect.");
  } else if (local.lastHeartbeatOk && openStudioTabs === 0) {
    setSummary("Connected, but no YouTube Studio tab is open. Open Studio before expecting detection.");
  } else if (connectorConfig && connectorConfig.ok === false) {
    setSummary(connectorConfig.error || "Connector config could not be loaded.");
  } else {
    setSummary(`Connected to ${sync.appUrl}. Passive checks run hourly.`);
  }
  document.getElementById("lastHeartbeat").textContent = local.lastHeartbeatAt
    ? `${formatTime(local.lastHeartbeatAt)} (${local.lastHeartbeatOk ? "ok" : "failed"}${local.lastHeartbeatOk ? `, ${openStudioTabs} Studio tab${openStudioTabs === 1 ? "" : "s"}` : ""})`
    : "Never";
  document.getElementById("lastEvent").textContent = local.lastEventPostAt
    ? `${formatTime(local.lastEventPostAt)} (${local.lastEventPostOk ? "ok" : "failed"})`
    : "Never";
}

async function openWatcherTargets(targets, loadingText) {
  setSummary(loadingText);
  const response = await chrome.runtime.sendMessage({ type: "open-watcher-tabs", targets });
  if (!response?.ok) {
    setSummary(response?.error || "Could not open watcher tabs.");
    return;
  }
  const count = response.opened?.length || 0;
  const heartbeatText = response.heartbeat?.ok === false ? " Heartbeat failed." : " Heartbeat sent.";
  const scanText = response.scan?.ok === false ? " Scan could not run yet." : " Scan requested.";
  const doneText = `Opened ${count} watcher tab${count === 1 ? "" : "s"}.${heartbeatText}${scanText}`;
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

function formatTime(value) {
  return new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function latestOwnHeartbeat(result, actorName) {
  const statuses = result?.connectorStatus || [];
  if (!statuses.length) return null;
  if (!actorName) return statuses[0];
  return statuses.find((item) => item.actorName === actorName) || statuses[0];
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
