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
        channelTitle: snippet.channelTitle || ""
      };
    }
  }
  for (const record of records) {
    const item = metadata[record.videoId];
    if (!item) continue;
    record.currentYoutubeTitle = item.title;
    record.currentYoutubeThumbnailUrl = item.thumbnailUrl;
    record.youtubeChannelTitle = item.channelTitle;
    if (!record.channel && item.channelTitle) record.channel = item.channelTitle;
  }
  return { records, warnings };
}

function bestThumbnailUrl(thumbnails) {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbnails[key]?.url) return thumbnails[key].url;
  }
  return "";
}
