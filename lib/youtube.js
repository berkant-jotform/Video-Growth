const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";

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
    const response = await fetch(`${YOUTUBE_BASE_URL}/videos?${params.toString()}`, {
      headers: { Accept: "application/json" }
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
    if (!item) continue;
    const channel = channelMetadata[item.channelId] || {};
    record.currentYoutubeTitle = item.title;
    record.currentYoutubeThumbnailUrl = item.thumbnailUrl;
    record.youtubeChannelTitle = channel.title || item.channelTitle;
    record.youtubeChannelThumbnailUrl = channel.thumbnailUrl || "";
    if (!record.channel && record.youtubeChannelTitle) record.channel = record.youtubeChannelTitle;
  }
  return { records, warnings };
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
    const response = await fetch(`${YOUTUBE_BASE_URL}/channels?${params.toString()}`, {
      headers: { Accept: "application/json" }
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
