document.addEventListener("DOMContentLoaded", async () => {
  await render();
  document.getElementById("openWatchers").addEventListener("click", async () => {
    setSummary("Opening configured Studio watcher tabs...");
    const response = await chrome.runtime.sendMessage({ type: "open-watcher-tabs" });
    setSummary(response?.ok ? `Opened ${response.opened?.length || 0} watcher tab${response.opened?.length === 1 ? "" : "s"}.` : response?.error || "Could not open watcher tabs.");
    await render();
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
  const latestHeartbeat = latestOwnHeartbeat(local.lastHeartbeatResult, sync.actorName);
  const openStudioTabs = Number(latestHeartbeat?.payload?.openStudioTabs || 0);
  if (!sync.appUrl) {
    setSummary("Open Settings to connect.");
  } else if (local.lastHeartbeatOk && openStudioTabs === 0) {
    setSummary("Connected, but no YouTube Studio tab is open. Open Studio before expecting detection.");
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
