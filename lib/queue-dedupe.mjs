const STATUS_PRIORITY = {
  action_conflict: 100,
  confirmed_finished: 90,
  applied_change_observed: 80,
  past_due_check: 70,
  uncovered: 50,
  watching: 40,
  missing_data: 10
};

export function dedupeQueueRuns(runs = []) {
  const clusters = [];
  const byKey = new Map();

  for (const run of runs) {
    const key = logicalRunKey(run);
    if (!key) {
      clusters.push({ run: { ...run }, sources: [sourceReference(run)] });
      continue;
    }
    const candidates = byKey.get(key) || [];
    const cluster = candidates.find((item) => isCrossSourceDuplicate(item.sources, run));
    if (!cluster) {
      const created = { run: { ...run }, sources: [sourceReference(run)] };
      candidates.push(created);
      byKey.set(key, candidates);
      clusters.push(created);
      continue;
    }
    cluster.sources.push(sourceReference(run));
    cluster.run = mergeDuplicateRuns(cluster.run, run);
  }

  const deduped = clusters.map((cluster) => ({
    ...cluster.run,
    duplicateCount: Math.max(0, cluster.sources.length - 1),
    duplicateSources: uniqueSources(cluster.sources)
  }));
  applyRetestFlags(deduped);
  return deduped;
}

export function logicalRunKey(run) {
  if (!run || run.unregistered) return "";
  const videoId = String(run.videoId || "").trim();
  const testType = String(run.testType || "").trim();
  const startDate = dateOnly(run.startDate);
  const optionFingerprint = String(run.optionFingerprint || "").trim();
  if (!videoId || !testType || (!startDate && !optionFingerprint)) return "";
  return [videoId, testType, startDate, optionFingerprint].join("|");
}

function isCrossSourceDuplicate(sources, run) {
  const incoming = sourceReference(run);
  return sources.some((source) =>
    (source.spreadsheetId === incoming.spreadsheetId &&
      source.sheetName === incoming.sheetName &&
      source.rowNumber === incoming.rowNumber) ||
    source.spreadsheetId !== incoming.spreadsheetId ||
    source.sheetName !== incoming.sheetName
  );
}

function mergeDuplicateRuns(left, right) {
  const preferred = runScore(right) > runScore(left) ? right : left;
  const fallback = preferred === right ? left : right;
  return {
    ...fallback,
    ...preferred,
    videoTitle: preferred.videoTitle || fallback.videoTitle,
    currentYoutubeTitle: preferred.currentYoutubeTitle || fallback.currentYoutubeTitle,
    currentYoutubeThumbnailUrl: preferred.currentYoutubeThumbnailUrl || fallback.currentYoutubeThumbnailUrl,
    youtubeChannelId: preferred.youtubeChannelId || fallback.youtubeChannelId,
    youtubeChannelTitle: preferred.youtubeChannelTitle || fallback.youtubeChannelTitle,
    youtubeChannelThumbnailUrl: preferred.youtubeChannelThumbnailUrl || fallback.youtubeChannelThumbnailUrl,
    finishEventId: preferred.finishEventId || fallback.finishEventId,
    finishEventSource: preferred.finishEventSource || fallback.finishEventSource,
    finishEventText: preferred.finishEventText || fallback.finishEventText,
    finishEventAt: preferred.finishEventAt || fallback.finishEventAt,
    thumbnailPreviews: {
      ...(fallback.thumbnailPreviews || {}),
      ...(preferred.thumbnailPreviews || {})
    }
  };
}

function runScore(run) {
  const status = STATUS_PRIORITY[run.queueStatus] || 0;
  const finishSignal = run.finishEventId ? 20 : 0;
  const currentMetadata = run.currentYoutubeTitle ? 5 : 0;
  const optionCount = Object.values(run.options || {}).filter(Boolean).length;
  const troublePenalty = Array.isArray(run.troubles) ? run.troubles.length : 0;
  return status + finishSignal + currentMetadata + optionCount - troublePenalty;
}

function applyRetestFlags(runs) {
  const byVideoAndType = new Map();
  for (const run of runs) {
    if (run.unregistered || !run.videoId || !run.testType) continue;
    const key = `${run.videoId}|${run.testType}`;
    const materialKey = `${dateOnly(run.startDate)}|${run.optionFingerprint || ""}`;
    const entries = byVideoAndType.get(key) || new Set();
    entries.add(materialKey);
    byVideoAndType.set(key, entries);
  }
  for (const run of runs) {
    if (run.unregistered || !run.videoId || !run.testType) continue;
    run.possibleRetest = (byVideoAndType.get(`${run.videoId}|${run.testType}`)?.size || 0) > 1;
  }
}

function sourceReference(run) {
  return {
    spreadsheetId: String(run.spreadsheetId || ""),
    sheetName: String(run.sheetName || ""),
    rowNumber: Number(run.rowNumber || 0)
  };
}

function uniqueSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.spreadsheetId}|${source.sheetName}|${source.rowNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
