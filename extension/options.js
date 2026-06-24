const FIELDS = ["appUrl", "connectorToken", "actorName", "channels"];
const DEFAULTS = {
  appUrl: "https://video-growth.vercel.app",
  connectorToken: "",
  actorName: "",
  channels: "Jotform, AI Agents Podcast, AI Agents"
};

document.addEventListener("DOMContentLoaded", async () => {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(FIELDS)) };
  for (const field of FIELDS) {
    document.getElementById(field).value = settings[field] || "";
  }
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("heartbeat").addEventListener("click", heartbeat);
});

async function save() {
  const updates = Object.fromEntries(
    FIELDS.map((field) => [field, document.getElementById(field).value.trim()])
  );
  if (!updates.connectorId) {
    const current = await chrome.storage.sync.get("connectorId");
    updates.connectorId = current.connectorId || crypto.randomUUID();
  }
  await chrome.storage.sync.set(updates);
  setStatus("Saved.");
}

async function heartbeat() {
  await save();
  const response = await chrome.runtime.sendMessage({ type: "send-heartbeat" });
  setStatus(response?.ok ? "Heartbeat sent." : response?.error || "Heartbeat failed.");
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}
