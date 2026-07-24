export function planAppManagedConsolidation(runs = []) {
  const groups = new Map();

  for (const run of runs) {
    const key = appManagedGroupKey(run);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(run);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => {
      const ranked = [...group].sort(compareCanonicalRuns);
      return {
        canonicalId: ranked[0].testRunId,
        duplicateIds: ranked.slice(1).map((run) => run.testRunId),
        key: appManagedGroupKey(ranked[0])
      };
    });
}

function appManagedGroupKey(run = {}) {
  if (run.sourceKind !== "app_registry" || run.status === "source_removed") return "";
  const testType = String(run.testType || "").trim();
  const videoId = String(run.videoId || "").trim();
  if (!testType) return "";
  if (videoId) return `video|${videoId}|${testType}`;

  const title = normalizeText(run.currentYoutubeTitle || run.videoTitle);
  const channel = normalizeText(run.youtubeChannelId || run.youtubeChannelTitle || run.channel);
  if (!title || !channel) return "";
  return `title|${title}|${testType}|${channel}`;
}

function compareCanonicalRuns(left, right) {
  const scoreDifference = canonicalScore(right) - canonicalScore(left);
  if (scoreDifference) return scoreDifference;
  const timeDifference = new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
  if (timeDifference) return timeDifference;
  return String(left.testRunId || "").localeCompare(String(right.testRunId || ""));
}

function canonicalScore(run = {}) {
  return (
    (Number(run.activeActionCount || 0) > 0 ? 10_000 : 0) +
    Math.min(100, Number(run.matchedEventCount || 0)) * 100 +
    (run.videoId ? 50 : 0) +
    (run.currentYoutubeTitle ? 20 : 0) +
    (run.youtubeChannelId ? 10 : 0) +
    (run.currentYoutubeThumbnailUrl ? 5 : 0)
  );
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
