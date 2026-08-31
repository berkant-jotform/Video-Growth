export function selectConnectorTarget(statuses = [], requestedChannels = []) {
  const channels = normalizeChannels(requestedChannels);
  const candidates = (Array.isArray(statuses) ? statuses : [])
    .filter((item) => item?.active && item.connectorId && supportsDurableJobs(item))
    .map((item) => ({ item, score: connectorScore(item, channels) }))
    .sort((left, right) => right.score - left.score || newestFirst(left.item, right.item));
  return candidates[0]?.item?.connectorId || "";
}

export function connectorCoverageLabels(status = {}) {
  const payload = status?.payload || {};
  return normalizeChannels([
    ...(Array.isArray(payload.ownedWatchers) ? payload.ownedWatchers.map((item) => item?.label) : []),
    ...(Array.isArray(payload.studioTabs) ? payload.studioTabs.map((item) => item?.channel) : [])
  ]);
}

function connectorScore(item, channels) {
  const openLabels = new Set(connectorCoverageLabels(item).map(channelKey));
  const configuredLabels = new Set(normalizeChannels(item.channels).map(channelKey));
  const openTabs = Number(item?.payload?.openStudioTabs || 0);
  const channelScore = channels.length
    ? channels.reduce((score, channel) => {
        const key = channelKey(channel);
        if (openLabels.has(key)) return score + 100;
        if (configuredLabels.has(key)) return score + 10;
        return score;
      }, 0)
    : openLabels.size * 50 + Math.min(openTabs, 20) * 5;
  const age = Date.now() - new Date(item.lastSeenAt || 0).getTime();
  const freshness = Number.isFinite(age) ? Math.max(0, 20 - Math.floor(age / 60_000)) : 0;
  return channelScore + freshness;
}

function supportsDurableJobs(item) {
  if (item?.payload?.capabilities?.durableJobs === true) return true;
  const parts = String(item?.version || "").split(".").map((value) => Number(value) || 0);
  return parts[0] >= 1;
}

function newestFirst(left, right) {
  return new Date(right.lastSeenAt || 0).getTime() - new Date(left.lastSeenAt || 0).getTime();
}

function normalizeChannels(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return Array.from(new Set(items.map((item) => String(item || "").trim()).filter(Boolean)));
}

function channelKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
