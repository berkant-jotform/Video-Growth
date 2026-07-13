export function isStudioFinishSignalSource(source) {
  const value = String(source || "").trim();
  return Boolean(value && value !== "metadata");
}

export function finishSignalSourceName(source) {
  const value = String(source || "").trim();
  if (value === "metadata") return "Metadata observed";
  if (value === "studio_page_status") return "Studio page status";
  if (isStudioFinishSignalSource(value)) return "Studio notification";
  return "";
}

export function hasFreshConnectorData(items = [], selectedChannels = [], now = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000) {
  const selected = selectedChannels.map(normalizeChannel).filter(Boolean);
  const fresh = items.filter((item) => {
    if (!item?.active) return false;
    const checkedAt = item.payload?.lastStudioScan?.checkedAt || item.lastSeenAt || "";
    const checkedTime = new Date(checkedAt).valueOf();
    return Number.isFinite(checkedTime) && now - checkedTime < maxAgeMs;
  });
  if (!selected.length) return fresh.length > 0;
  return selected.every((channel) =>
    fresh.some((item) => (item.channels || []).some((candidate) => normalizeChannel(candidate) === channel))
  );
}

function normalizeChannel(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
