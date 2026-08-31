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
      const titleMatch = youtubeTitleMatchMetrics(title, snippet.title || "");
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
        score: Math.min(1, titleMatch.score + channelBonus),
        exactTitle: titleMatch.exact,
        queryCoverage: titleMatch.queryCoverage,
        candidateCoverage: titleMatch.candidateCoverage
      };
    })
    .filter((item) => item.videoId && item.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  searchCache.set(cacheKey, { fetchedAt: Date.now(), items });
  return items;
}

export function youtubeTitleMatchMetrics(requestedTitle, candidateTitle) {
  const requested = normalizeBasic(requestedTitle);
  const candidate = normalizeBasic(candidateTitle);
  if (!requested || !candidate) {
    return { exact: false, queryCoverage: 0, candidateCoverage: 0, score: 0 };
  }
  if (requested === candidate) {
    return { exact: true, queryCoverage: 1, candidateCoverage: 1, score: 1 };
  }
  const left = new Set(requested.split(" ").filter((token) => token.length >= 3));
  const right = new Set(candidate.split(" ").filter((token) => token.length >= 3));
  if (!left.size || !right.size) {
    return { exact: false, queryCoverage: 0, candidateCoverage: 0, score: 0 };
  }
  const overlap = [...left].filter((token) => right.has(token)).length;
  const queryCoverage = overlap / left.size;
  const candidateCoverage = overlap / right.size;
  return {
    exact: false,
    queryCoverage,
    candidateCoverage,
    score: Math.min(queryCoverage, candidateCoverage)
  };
}

export function isTrustedYouTubeSearchCandidate(event = {}, candidate = {}) {
  if (!candidate.videoId || !candidate.title) return false;
  const metrics = youtubeTitleMatchMetrics(event.videoTitle, candidate.title);
  if (metrics.exact) return true;
  if (metrics.queryCoverage < 0.82 || metrics.candidateCoverage < 0.65) return false;

  const eventChannelId = String(event.channelId || "").trim();
  const sameChannelId = Boolean(
    eventChannelId && candidate.channelId && eventChannelId === candidate.channelId
  );
  const sameChannelName = Boolean(
    canonicalChannelName(event.channel) &&
    canonicalChannelName(candidate.channel) &&
    normalizeBasic(canonicalChannelName(event.channel)) === normalizeBasic(canonicalChannelName(candidate.channel))
  );
  const score = Number(candidate.score || metrics.score);
  if (score >= 0.95 && metrics.queryCoverage >= 0.9) return true;
  if (sameChannelId && score >= 0.76) return true;
  return sameChannelName && score >= 0.84;
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

export async function fetchYouTubeVideoContexts(videoIds = [], apiKey = "") {
  if (!apiKey) return [];
  const ids = Array.from(new Set(videoIds.map((value) => String(value || "").trim()).filter(Boolean)));
  const contexts = [];
  for (let idx = 0; idx < ids.length; idx += 50) {
    const batch = ids.slice(idx, idx + 50);
    const params = new URLSearchParams({
      part: "snippet,contentDetails,liveStreamingDetails,status",
      id: batch.join(","),
      key: apiKey
    });
    const response = await fetchWithTimeout(`${YOUTUBE_BASE_URL}/videos?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 15_000
    });
    if (!response.ok) {
      throw new Error(`YouTube video context request failed (${response.status}).`);
    }
    const payload = await response.json();
    contexts.push(...(payload.items || []).map(videoContextFromApiItem));
  }
  return contexts;
}

export function parseIsoDurationSeconds(value = "") {
  const match = String(value || "").match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!match) return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  return Math.round(
    Number(days) * 86_400 +
    Number(hours) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
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

function videoContextFromApiItem(item) {
  return {
    videoId: item.id || "",
    publishedAt: item.snippet?.publishedAt || "",
    definition: item.contentDetails?.definition || "",
    durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration),
    liveArchive: Boolean(
      item.liveStreamingDetails?.actualStartTime &&
      item.liveStreamingDetails?.actualEndTime
    ),
    madeForKids:
      typeof item.status?.madeForKids === "boolean"
        ? item.status.madeForKids
        : null,
    privacyStatus: item.status?.privacyStatus || "",
    contextFetchedAt: new Date().toISOString()
  };
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
