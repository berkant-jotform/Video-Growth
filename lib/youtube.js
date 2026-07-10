import { fetchWithTimeout } from "./fetch.js";
import { canonicalChannelName } from "./channels.mjs";

const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const searchCache = new Map();
const videoMetadataCache = new Map();

export async function enrichWithYouTubeMetadata(records, config) {
  if (!config.youtubeApiKey) return { records, warnings: [] };
  const videoIds = Array.from(new Set(records.map((record) => record.videoId).filter(Boolean)));
  const warnings = [];
  const metadata = {};
  for (let idx = 0; idx < videoIds.length; idx += 50) {
    const batch = videoIds.slice(idx, idx + 50);
    const params = new URLSearchParams({
      part: "snippet",
      id: batch.join(","),
      key: config.youtubeApiKey
    });
    const response = await fetchWithTimeout(`${YOUTUBE_BASE_URL}/videos?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 15_000
    });
    if (!response.ok) {
      warnings.push(`YouTube metadata skipped for ${batch.length} videos: ${response.status}`);
      continue;
    }
    const payload = await response.json();
    for (const item of payload.items || []) {
      const snippet = item.snippet || {};
      metadata[item.id] = {
        title: snippet.title || "",
        thumbnailUrl: bestThumbnailUrl(snippet.thumbnails || {}),
        channelId: snippet.channelId || "",
        channelTitle: snippet.channelTitle || ""
      };
    }
  }
  const channelIds = Array.from(new Set(Object.values(metadata).map((item) => item.channelId).filter(Boolean)));
  const channelMetadata = await fetchChannelMetadata(channelIds, config.youtubeApiKey, warnings);
  for (const record of records) {
    const item = metadata[record.videoId];
    if (!item) {
      if (record.videoId) {
        record.troubles ||= [];
        record.troubles.push({
          severity: "warning",
          code: "youtube_video_unavailable",
          message: "YouTube Data API did not return this video. It may be private, deleted, or inaccessible to the API key."
        });
      }
      continue;
    }
    const channel = channelMetadata[item.channelId] || {};
    record.currentYoutubeTitle = item.title;
    record.currentYoutubeThumbnailUrl = item.thumbnailUrl;
    record.youtubeChannelId = item.channelId || "";
    record.youtubeChannelTitle = channel.title || item.channelTitle;
    record.youtubeChannelThumbnailUrl = channel.thumbnailUrl || "";
    if (record.youtubeChannelTitle) {
      record.channel = canonicalChannelName(record.youtubeChannelTitle) || record.youtubeChannelTitle;
    }
  }
  return { records, warnings };
}

export async function findYouTubeVideoCandidates({ title, channel = "", channelId = "", apiKey, limit = 3 } = {}) {
  if (!apiKey || !title) return [];
  const cacheKey = `${normalizeBasic(title)}|${normalizeBasic(channel)}|${channelId}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) {
    return cached.items;
  }
  const params = new URLSearchParams({
    part: "snippet",
    q: title,
    type: "video",
    maxResults: "5",
    key: apiKey
  });
  if (channelId) params.set("channelId", channelId);
  const response = await fetchWithTimeout(`${YOUTUBE_BASE_URL}/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
    timeoutMs: 15_000
  });
  if (!response.ok) return [];
  const payload = await response.json();
  const items = (payload.items || [])
    .map((item) => {
      const snippet = item.snippet || {};
      const videoId = item.id?.videoId || "";
      const titleScore = tokenOverlap(title, snippet.title || "");
      const channelBonus =
        channelId && snippet.channelId === channelId
          ? 0.18
          : channel && normalizeBasic(channel) === normalizeBasic(snippet.channelTitle || "")
            ? 0.12
            : 0;
      return {
        videoId,
        title: snippet.title || "",
        channel: snippet.channelTitle || "",
        channelId: snippet.channelId || "",
        score: Math.min(1, titleScore + channelBonus)
      };
    })
    .filter((item) => item.videoId && item.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  searchCache.set(cacheKey, { fetchedAt: Date.now(), items });
  return items;
}

export async function fetchYouTubeVideoMetadata(videoIds = [], apiKey = "") {
  if (!apiKey) return {};
  const ids = Array.from(new Set(videoIds.map((value) => String(value || "").trim()).filter(Boolean)));
  const metadata = {};
  const missing = [];
  for (const videoId of ids) {
    const cached = videoMetadataCache.get(videoId);
    if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) metadata[videoId] = cached.item;
    else missing.push(videoId);
  }
  for (let idx = 0; idx < missing.length; idx += 50) {
    const batch = missing.slice(idx, idx + 50);
    const params = new URLSearchParams({
      part: "snippet",
      id: batch.join(","),
      key: apiKey
    });
    const response = await fetchWithTimeout(`${YOUTUBE_BASE_URL}/videos?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 15_000
    });
    if (!response.ok) continue;
    const payload = await response.json();
    for (const item of payload.items || []) {
      const snippet = item.snippet || {};
      const resolved = {
        videoId: item.id || "",
        title: snippet.title || "",
        thumbnailUrl: bestThumbnailUrl(snippet.thumbnails || {}),
        channelId: snippet.channelId || "",
        channelTitle: snippet.channelTitle || ""
      };
      metadata[item.id] = resolved;
      videoMetadataCache.set(item.id, { fetchedAt: Date.now(), item: resolved });
    }
  }
  return metadata;
}

async function fetchChannelMetadata(channelIds, apiKey, warnings) {
  const metadata = {};
  for (let idx = 0; idx < channelIds.length; idx += 50) {
    const batch = channelIds.slice(idx, idx + 50);
    const params = new URLSearchParams({
      part: "snippet",
      id: batch.join(","),
      key: apiKey
    });
    const response = await fetchWithTimeout(`${YOUTUBE_BASE_URL}/channels?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 15_000
    });
    if (!response.ok) {
      warnings.push(`YouTube channel logos skipped for ${batch.length} channels: ${response.status}`);
      continue;
    }
    const payload = await response.json();
    for (const item of payload.items || []) {
      const snippet = item.snippet || {};
      metadata[item.id] = {
        title: snippet.title || "",
        thumbnailUrl: bestThumbnailUrl(snippet.thumbnails || {})
      };
    }
  }
  return metadata;
}

function bestThumbnailUrl(thumbnails) {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbnails[key]?.url) return thumbnails[key].url;
  }
  return "";
}

function tokenOverlap(a, b) {
  const left = new Set(normalizeBasic(a).split(" ").filter((token) => token.length >= 3));
  const right = new Set(normalizeBasic(b).split(" ").filter((token) => token.length >= 3));
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.min(left.size, right.size);
}

function normalizeBasic(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
