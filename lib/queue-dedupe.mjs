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
    if (run.sourceKind === "app_registry") {
      const existing = clusters.find((item) => sameAppManagedRun(item.run, run));
      if (existing) {
        existing.sources.push(sourceReference(run));
        existing.run = mergeDuplicateRuns(existing.run, run);
        continue;
      }
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
  if (run.sourceKind === "app_registry") {
    const title = normalizeText(run.currentYoutubeTitle || run.videoTitle);
    const channel = normalizeText(run.youtubeChannelId || run.youtubeChannelTitle || run.channel);
    if (!testType || (!videoId && !title)) return "";
    return videoId
      ? ["studio-only", videoId, testType].join("|")
      : ["studio-only", title, testType, channel].join("|");
  }
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
  const resolvedVideo = run.videoId ? 10 : 0;
  return status + finishSignal + currentMetadata + resolvedVideo + optionCount - troublePenalty;
}

function sameAppManagedRun(left, right) {
  if (left?.sourceKind !== "app_registry" || right?.sourceKind !== "app_registry") return false;
  if (!left.testType || left.testType !== right.testType) return false;
  if (left.videoId && right.videoId) return left.videoId === right.videoId;
  const leftTitles = titleCandidates(left);
  const rightTitles = titleCandidates(right);
  if (!leftTitles.some((title) => rightTitles.includes(title))) return false;
  const leftChannel = normalizeText(left.youtubeChannelTitle || left.channel);
  const rightChannel = normalizeText(right.youtubeChannelTitle || right.channel);
  const unknownChannel = (value) => !value || value === "unknown source" || value === "account" || value === "channel";
  if (unknownChannel(leftChannel) || unknownChannel(rightChannel)) return true;
  if (leftChannel === rightChannel) return true;
  const leftChannelId = normalizeText(left.youtubeChannelId);
  const rightChannelId = normalizeText(right.youtubeChannelId);
  return Boolean(leftChannelId && rightChannelId && leftChannelId === rightChannelId);
}

function titleCandidates(run) {
  return Array.from(new Set([run?.currentYoutubeTitle, run?.videoTitle].map(normalizeText).filter(Boolean)));
}

function applyRetestFlags(runs) {
  const byVideoAndType = new Map();
  for (const run of runs) {
    if (!hasAuthoritativeRetestEvidence(run)) continue;
    const key = `${run.videoId}|${run.testType}`;
    const materialKey = `${dateOnly(run.startDate)}|${run.optionFingerprint || ""}`;
    const entries = byVideoAndType.get(key) || new Set();
    entries.add(materialKey);
    byVideoAndType.set(key, entries);
  }
  for (const run of runs) {
    if (!hasAuthoritativeRetestEvidence(run)) {
      run.possibleRetest = false;
      continue;
    }
    run.possibleRetest = (byVideoAndType.get(`${run.videoId}|${run.testType}`)?.size || 0) > 1;
  }
}

function hasAuthoritativeRetestEvidence(run) {
  if (!run || run.unregistered || run.sourceKind === "app_registry") return false;
  if (!run.videoId || !run.testType) return false;
  return Boolean(dateOnly(run.startDate) || String(run.optionFingerprint || "").trim());
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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
