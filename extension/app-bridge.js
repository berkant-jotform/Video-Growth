(() => {
  const APP_MESSAGE_SOURCE = "youtube-ab-tests-app";
  const EXTENSION_MESSAGE_SOURCE = "youtube-ab-tests-extension";
  const BRIDGE_VERSION = chrome.runtime.getManifest().version;

  function announceReady() {
    window.postMessage({
      source: EXTENSION_MESSAGE_SOURCE,
      type: "bridge-ready",
      version: BRIDGE_VERSION
    }, window.location.origin);
  }

  globalThis.__youtubeAbTestsAppBridgeLoaded = true;
  globalThis.__youtubeAbTestsAppBridgeVersion = BRIDGE_VERSION;

  if (globalThis.__youtubeAbTestsAppBridgeMessageHandler) {
    window.removeEventListener("message", globalThis.__youtubeAbTestsAppBridgeMessageHandler);
  }
  if (globalThis.__youtubeAbTestsAppBridgeFocusHandler) {
    window.removeEventListener("focus", globalThis.__youtubeAbTestsAppBridgeFocusHandler);
  }
  if (globalThis.__youtubeAbTestsAppBridgeVisibilityHandler) {
    document.removeEventListener("visibilitychange", globalThis.__youtubeAbTestsAppBridgeVisibilityHandler);
  }
  if (globalThis.__youtubeAbTestsAppBridgeReadyTimer) {
    window.clearInterval(globalThis.__youtubeAbTestsAppBridgeReadyTimer);
  }

  const messageHandler = async (event) => {
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
  };
  const focusHandler = () => announceReady();
  const visibilityHandler = () => {
    if (!document.hidden) announceReady();
  };

  globalThis.__youtubeAbTestsAppBridgeMessageHandler = messageHandler;
  globalThis.__youtubeAbTestsAppBridgeFocusHandler = focusHandler;
  globalThis.__youtubeAbTestsAppBridgeVisibilityHandler = visibilityHandler;
  globalThis.__youtubeAbTestsAppBridgeReadyTimer = window.setInterval(announceReady, 10000);

  window.addEventListener("message", messageHandler);
  window.addEventListener("focus", focusHandler);
  document.addEventListener("visibilitychange", visibilityHandler);

  announceReady();
  window.setTimeout(announceReady, 400);
  window.setTimeout(announceReady, 1400);
  window.setTimeout(announceReady, 3200);
})();
