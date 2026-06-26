import { canonicalChannelName } from "@/lib/channels.mjs";

const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";
const CACHE_TTL_MS = 10 * 60 * 1000;

let memoryCache = {
  key: "",
  fetchedAt: 0,
  logos: {}
};

export async function loadConfiguredChannelLogos(config) {
  if (!config?.youtubeApiKey || !config?.connectorWatcherTabs?.length) return {};
  const targets = config.connectorWatcherTabs
    .map((tab) => ({
      label: canonicalChannelName(tab.label) || tab.label || "",
      channelId: extractStudioChannelId(tab.url)
    }))
    .filter((target) => target.label && target.channelId);
  if (!targets.length) return {};

  const key = targets.map((target) => `${target.label}:${target.channelId}`).sort().join("|");
  if (memoryCache.key === key && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryCache.logos;
  }

  const logos = {};
  for (let idx = 0; idx < targets.length; idx += 50) {
    const batch = targets.slice(idx, idx + 50);
    const params = new URLSearchParams({
      part: "snippet",
      id: batch.map((target) => target.channelId).join(","),
      key: config.youtubeApiKey
    });
    const response = await fetch(`${YOUTUBE_BASE_URL}/channels?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) continue;
    const payload = await response.json();
    const byId = new Map((payload.items || []).map((item) => [item.id, bestThumbnailUrl(item.snippet?.thumbnails || {})]));
    for (const target of batch) {
      const logoUrl = byId.get(target.channelId);
      if (logoUrl) logos[target.label] = logoUrl;
    }
  }

  memoryCache = {
    key,
    fetchedAt: Date.now(),
    logos
  };
  return logos;
}

export function applyChannelLogoFallbacks(runs, logoMap) {
  if (!logoMap || !Object.keys(logoMap).length) return runs;
  return runs.map((run) => {
    if (run.youtubeChannelThumbnailUrl) return run;
    const channel = canonicalChannelName(run.channel || run.youtubeChannelTitle) || run.channel;
    const logoUrl = logoMap[channel];
    return logoUrl ? { ...run, youtubeChannelThumbnailUrl: logoUrl } : run;
  });
}

function extractStudioChannelId(url) {
  const match = String(url || "").match(/studio\.youtube\.com\/channel\/([^/?#]+)/i);
  return match?.[1] || "";
}

function bestThumbnailUrl(thumbnails) {
  for (const key of ["high", "medium", "default"]) {
    if (thumbnails[key]?.url) return thumbnails[key].url;
  }
  return "";
}
