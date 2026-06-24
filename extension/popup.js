document.addEventListener("DOMContentLoaded", async () => {
  await render();
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
    "lastEventPostAt",
    "lastEventPostOk"
  ]);
  setSummary(sync.appUrl ? `Connected to ${sync.appUrl}` : "Open Settings to connect.");
  document.getElementById("lastHeartbeat").textContent = local.lastHeartbeatAt
    ? `${formatTime(local.lastHeartbeatAt)} (${local.lastHeartbeatOk ? "ok" : "failed"})`
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
