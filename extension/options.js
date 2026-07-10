const FIELDS = ["appUrl", "connectorToken", "actorName"];
const DEFAULTS = {
  appUrl: "https://video-growth.vercel.app",
  connectorToken: "",
  actorName: ""
};

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("versionBadge").textContent = `v${chrome.runtime.getManifest().version}`;
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(FIELDS)) };
  for (const field of FIELDS) {
    document.getElementById(field).value = settings[field] || "";
  }
  document.getElementById("save").addEventListener("click", saveAndCheck);
  document.getElementById("heartbeat").addEventListener("click", heartbeat);
  document.getElementById("toggleToken").addEventListener("click", toggleTokenVisibility);
  updateWebSetupLink(settings.appUrl);
});

async function save() {
  const updates = Object.fromEntries(
    FIELDS.map((field) => [field, document.getElementById(field).value.trim()])
  );
  validateSettings(updates);
  if (!updates.connectorId) {
    const current = await chrome.storage.sync.get("connectorId");
    updates.connectorId = current.connectorId || crypto.randomUUID();
  }
  await chrome.storage.sync.set(updates);
  updateWebSetupLink(updates.appUrl);
  setStatus("Saved. Checking the dashboard connection...");
  return updates;
}

function validateSettings(settings) {
  let url;
  try {
    url = new URL(settings.appUrl);
  } catch {
    throw new Error("Enter a valid cloud app URL.");
  }
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use an HTTPS app URL, or localhost for development.");
  }
  if (!local && url.hostname !== "video-growth.vercel.app") {
    throw new Error("Use https://video-growth.vercel.app so the dashboard bridge has permission to connect.");
  }
  if (settings.connectorToken.length < 16) {
    throw new Error("Paste the browser connection token from the website Extension page.");
  }
  if (!settings.actorName) {
    throw new Error("Enter your initials or reviewer name.");
  }
}

async function saveAndCheck() {
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "send-heartbeat" });
    setStatus(response?.ok ? "Connected. Open the extension popup to start watching." : response?.error || "Connection check failed.");
  } catch (error) {
    setStatus(error.message || "Could not save extension settings.");
  }
}

async function heartbeat() {
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "send-heartbeat" });
    setStatus(response?.ok ? "Connected. Dashboard check succeeded." : response?.error || "Connection check failed.");
  } catch (error) {
    setStatus(error.message || "Connection check failed.");
  }
}

function setStatus(text) {
  const element = document.getElementById("status");
  element.textContent = text;
  const normalized = String(text || "").toLowerCase();
  element.className = `status ${normalized.includes("connected") || normalized.includes("succeeded") ? "success" : normalized.includes("failed") || normalized.includes("could not") || normalized.includes("enter ") || normalized.includes("paste ") ? "error" : ""}`;
}

function toggleTokenVisibility() {
  const input = document.getElementById("connectorToken");
  const button = document.getElementById("toggleToken");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Show" : "Hide";
}

function updateWebSetupLink(appUrl) {
  const link = document.getElementById("openWebSetup");
  try {
    link.href = `${new URL(appUrl || DEFAULTS.appUrl).origin}/extension`;
  } catch {
    link.href = `${DEFAULTS.appUrl}/extension`;
  }
}
