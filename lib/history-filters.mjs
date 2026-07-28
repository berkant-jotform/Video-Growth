import { canonicalChannelName, compareChannels } from "./channels.mjs";

export function historyFilterOptions(items = []) {
  return {
    channels: Array.from(
      new Set(items.map((item) => displayHistoryChannel(item.channel)).filter(Boolean))
    ).sort(compareChannels),
    actions: Array.from(
      new Set(items.map((item) => String(item.action?.action || "").trim()).filter(Boolean))
    ).sort()
  };
}

export function filterHistoryItems(items = [], filters = {}) {
  const search = normalize(filters.search);
  const channel = String(filters.channel || "all");
  const action = String(filters.action || "all");
  const testType = String(filters.testType || "all").toLowerCase();
  const selectedChannel = normalize(displayHistoryChannel(channel));

  return items.filter((item) => {
    if (
      channel !== "all" &&
      normalize(displayHistoryChannel(item.channel)) !== selectedChannel
    ) {
      return false;
    }
    if (action !== "all" && item.action?.action !== action) return false;
    if (
      testType !== "all" &&
      String(item.testType || "").toLowerCase() !== testType
    ) {
      return false;
    }
    if (search && !historySearchText(item).includes(search)) return false;
    return true;
  });
}

export function displayHistoryChannel(value) {
  return canonicalChannelName(value) || String(value || "").trim() || "Unknown channel";
}

function historySearchText(item) {
  return normalize([
    item.videoTitle,
    item.currentYoutubeTitle,
    item.videoId,
    item.channel,
    displayHistoryChannel(item.channel),
    item.testType,
    item.action?.action,
    item.action?.actorName,
    item.action?.note
  ].join(" "));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
