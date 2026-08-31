import { canonicalChannelName } from "./channels.mjs";

export function normalizeChannelFilters(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "all");
}

export function matchesScanFilters(record, filters) {
  if (filters.testType && record.testType !== filters.testType) return false;
  if (!filters.channels?.length) return true;
  const candidates = [record.channel, record.sheetName, record.youtubeChannelTitle]
    .map(normalizeText)
    .filter(Boolean);
  return filters.channels.some((channel) => candidates.includes(normalizeText(channel)));
}

export function matchesPreEnrichmentScanFilters(record, filters) {
  if (matchesScanFilters(record, filters)) return true;
  if (filters.testType && record.testType !== filters.testType) return false;

  // Thumbnail workbooks often group rows by workflow instead of YouTube channel.
  // Keep those rows until YouTube enrichment can resolve the real channel.
  return Boolean(filters.channels?.length && record.sourceKind === "thumbnail");
}

export function matchesPostEnrichmentScanFilters(record, filters) {
  if (matchesScanFilters(record, filters)) return true;
  if (filters.testType && record.testType !== filters.testType) return false;

  // Mixed thumbnail tabs cannot be scoped accurately before enrichment. Persist
  // every row from those small tabs so a scoped scan also repairs stale channel
  // labels and completed results for other channels.
  return Boolean(filters.channels?.length && record.sourceKind === "thumbnail");
}

function normalizeText(value) {
  return String(canonicalChannelName(value) || value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
