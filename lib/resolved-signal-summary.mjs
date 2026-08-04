import { canonicalChannelName } from "./channels.mjs";

export function mergeResolvedFinishSignalChannels(rows = [], days = 30) {
  const channels = {};
  for (const row of rows) {
    const channel = canonicalChannelName(row.channel) || String(row.channel || "Unknown source").trim() || "Unknown source";
    const count = Number(row.resolved_count || row.count || 0);
    const latestFinishedAt = row.latest_finished_at || row.latestFinishedAt || "";
    const current = channels[channel] || { count: 0, latestFinishedAt: "" };
    channels[channel] = {
      count: current.count + count,
      latestFinishedAt: newestTimestamp(current.latestFinishedAt, latestFinishedAt)
    };
  }
  return {
    days: Math.max(1, Math.min(90, Number(days) || 30)),
    total: Object.values(channels).reduce((sum, item) => sum + item.count, 0),
    channels
  };
}

function newestTimestamp(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return new Date(right).valueOf() > new Date(left).valueOf() ? right : left;
}
