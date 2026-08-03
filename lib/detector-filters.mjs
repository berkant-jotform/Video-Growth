export function matchesDetectorSearch(run = {}, channel = "", query = "") {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  const haystack = [
    run.videoTitle,
    run.currentYoutubeTitle,
    run.videoId,
    channel,
    run.channel,
    run.youtubeChannelTitle,
    run.result,
    run.explicitWinnerVariant,
    run.highestShareVariant,
    ...Object.values(run.options || {})
  ]
    .map(normalize)
    .filter(Boolean)
    .join(" ");
  return haystack.includes(normalizedQuery);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}
