export const EXTENSION_VERSION = "1.0.0";
export const PARSER_VERSION = "structured-notifications-v1";

export const EXTENSION_CAPABILITIES = Object.freeze({
  durableJobs: true,
  acknowledgedOutbox: true,
  ownedWatchers: true,
  exactChannelIdentity: true,
  remoteProfiles: true,
  safeCancellation: true,
  startupCatchup: true
});

export const JOB_TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);

export function stableEventKey(event = {}) {
  const identity = [
    cleanId(event.notificationId),
    cleanId(event.videoId),
    cleanId(event.channelId),
    normalizeText(event.videoTitle),
    normalizeOutcome(event.detectedOutcome),
    normalizeNotificationText(event.rawText || event.text)
  ].join("|");
  return `evt_${fnv1a(identity)}`;
}

export function normalizeNotificationText(value) {
  return normalizeText(value)
    .replace(/\b\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b/g, "")
    .replace(/\b(?:today|yesterday|this week|older)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function normalizeChannels(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return Array.from(new Set(input.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 30);
}

export function channelKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

export function channelIdentityMatches(left = {}, right = {}) {
  const leftId = cleanId(left.channelId || left.id);
  const rightId = cleanId(right.channelId || right.id);
  if (leftId && rightId) return leftId.toLowerCase() === rightId.toLowerCase();
  const leftName = channelKey(left.channel || left.label || left.name);
  const rightName = channelKey(right.channel || right.label || right.name);
  return Boolean(leftName && rightName && leftName === rightName);
}

export function channelIdentityConflict(expectedChannelId, observedChannelIds = [], tabUrl = "") {
  const expected = cleanId(expectedChannelId);
  if (!expected) return false;
  const urlChannelId = String(tabUrl || "").match(/\/channel\/(UC[A-Za-z0-9_-]{10,})/i)?.[1] || "";
  if (urlChannelId && urlChannelId !== expected) return true;
  return (Array.isArray(observedChannelIds) ? observedChannelIds : [observedChannelIds])
    .map(cleanId)
    .filter(Boolean)
    .some((channelId) => channelId !== expected);
}

export function summarizeChannelCoverage(tabs = [], requestedChannels = []) {
  const channels = normalizeChannels(requestedChannels);
  return channels.map((channel) => {
    const matches = tabs.filter((tab) => channelIdentityMatches(
      { channel },
      { channel: tab.channel, channelId: tab.channelId }
    ));
    const successful = matches.filter((tab) => tab.ok !== false && tab.checked === true);
    const conflicts = matches.filter((tab) => tab.identityConflict);
    return {
      channel,
      status: conflicts.length ? "wrong_account" : successful.length ? "checked" : matches.length ? "failed" : "missing_tab",
      tabs: matches.length,
      successfulTabs: successful.length,
      candidates: successful.reduce((sum, tab) => sum + Number(tab.candidates || 0), 0),
      received: successful.reduce((sum, tab) => sum + Number(tab.received || 0), 0),
      error: conflicts[0]?.error || matches.find((tab) => tab.error)?.error || ""
    };
  });
}

export function finalJobStatus(coverage = [], cancelled = false) {
  if (cancelled) return "cancelled";
  if (!coverage.length) return "completed";
  return coverage.every((item) => item.status === "checked") ? "completed" : "partial";
}

export function shouldRetryOutboxItem(item, now = Date.now()) {
  if (!item) return false;
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= now) return false;
  return !item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now;
}

export function nextRetryAt(attempts, now = Date.now()) {
  const exponent = Math.max(0, Math.min(8, Number(attempts || 0)));
  const base = Math.min(30 * 60_000, 2 ** exponent * 15_000);
  const jitter = Math.floor(base * 0.15);
  return new Date(now + base + jitter).toISOString();
}

export function progressPercent(completed, total) {
  if (!total) return 95;
  return Math.max(5, Math.min(95, Math.round((Number(completed || 0) / total) * 90) + 5));
}

function normalizeOutcome(value) {
  return normalizeText(value || "unknown").replace(/[^a-z0-9]+/g, "_");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 160);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
