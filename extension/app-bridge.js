const APP_MESSAGE_SOURCE = "youtube-ab-tests-app";
const EXTENSION_MESSAGE_SOURCE = "youtube-ab-tests-extension";

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const message = event.data || {};
  if (message.source !== APP_MESSAGE_SOURCE) return;
  if (!message.requestId) return;

  try {
    let response;
    if (message.type === "check-studio-now") {
      response = await chrome.runtime.sendMessage({ type: "scan-studio-tab" });
    } else if (message.type === "open-notification-page") {
      response = await chrome.runtime.sendMessage({ type: "open-notification-page" });
    } else if (message.type === "report-missed-notification") {
      response = await chrome.runtime.sendMessage({ type: "report-missed-notification" });
    } else {
      return;
    }
    window.postMessage({
      source: EXTENSION_MESSAGE_SOURCE,
      requestId: message.requestId,
      type: `${message.type}:result`,
      response
    }, window.location.origin);
  } catch (error) {
    window.postMessage({
      source: EXTENSION_MESSAGE_SOURCE,
      requestId: message.requestId,
      type: `${message.type}:result`,
      response: { ok: false, error: error.message || "Extension request failed." }
    }, window.location.origin);
  }
});
