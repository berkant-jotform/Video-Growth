(() => {
  const APP_MESSAGE_SOURCE = "youtube-ab-tests-app";
  const EXTENSION_MESSAGE_SOURCE = "youtube-ab-tests-extension";

  function announceReady() {
    window.postMessage({
      source: EXTENSION_MESSAGE_SOURCE,
      type: "bridge-ready",
      version: chrome.runtime.getManifest().version
    }, window.location.origin);
  }

  if (globalThis.__youtubeAbTestsAppBridgeLoaded) {
    announceReady();
    return;
  }

  globalThis.__youtubeAbTestsAppBridgeLoaded = true;

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== APP_MESSAGE_SOURCE) return;
    if (!message.requestId) return;

    try {
      let response;
      if (message.type === "ping-extension") {
        response = {
          ok: true,
          version: chrome.runtime.getManifest().version,
          bridgeReady: true
        };
      } else if (message.type === "check-studio-now") {
        response = await chrome.runtime.sendMessage({
          type: "scan-studio-tab",
          userInitiated: true,
          avoidTabSwitch: true,
          channelScope: Array.isArray(message.payload?.channels) ? message.payload.channels : [],
          testTypeScope: message.payload?.testType || "all"
        });
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

  announceReady();
})();
