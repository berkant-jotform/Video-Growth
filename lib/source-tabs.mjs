export const EXCLUDED_SHEET_TABS_KEY = "EXCLUDED_SHEET_TABS_JSON";
export const SOURCE_TAB_POLICIES_KEY = "SOURCE_TAB_POLICIES_JSON";
export const SOURCE_TAB_MODES = ["active", "archive", "ignore"];

export function parseExcludedSheetTabs(value) {
  if (!value) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Excluded sheet tabs must be a JSON array.");
  return parsed
    .map((item) => ({
      sourceKind: normalizeSourceKind(item?.sourceKind),
      sheetName: String(item?.sheetName || item?.title || "").trim()
    }))
    .filter((item) => item.sourceKind && item.sheetName);
}

export function stringifyExcludedSheetTabs(entries = []) {
  return JSON.stringify(parseExcludedSheetTabs(entries), null, 2);
}

export function parseSourceTabPolicies(value) {
  if (!value) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Source tab policies must be a JSON array.");
  const byKey = new Map();
  for (const item of parsed) {
    const sourceKind = normalizeSourceKind(item?.sourceKind);
    const sheetName = String(item?.sheetName || item?.title || "").trim();
    const mode = String(item?.mode || "active").trim().toLowerCase();
    if (!sourceKind || !sheetName) continue;
    if (!SOURCE_TAB_MODES.includes(mode)) {
      throw new Error(`Unsupported source tab mode "${mode}" for "${sheetName}".`);
    }
    byKey.set(sourceTabKey(sourceKind, sheetName), { sourceKind, sheetName, mode });
  }
  return Array.from(byKey.values());
}

export function stringifySourceTabPolicies(entries = []) {
  return JSON.stringify(parseSourceTabPolicies(entries), null, 2);
}

export function sourceTabPolicy({ sourceKind, sheetName }, policies = [], legacyExcluded = []) {
  const systemReason = systemExcludedReason({ sourceKind, sheetName });
  if (systemReason) return { mode: "ignore", reason: systemReason, source: "system" };
  const key = sourceTabKey(sourceKind, sheetName);
  const configured = parseSourceTabPolicies(policies).find(
    (item) => sourceTabKey(item.sourceKind, item.sheetName) === key
  );
  if (configured) {
    return {
      mode: configured.mode,
      reason: configured.mode === "archive"
        ? "Archived in Data Sources settings"
        : configured.mode === "ignore"
          ? "Ignored in Data Sources settings"
          : "Active in Data Sources settings",
      source: "settings"
    };
  }
  const legacyKeys = new Set(
    parseExcludedSheetTabs(legacyExcluded).map((item) => sourceTabKey(item.sourceKind, item.sheetName))
  );
  if (legacyKeys.has(key)) {
    return { mode: "ignore", reason: "Ignored by legacy excluded-tab setting", source: "legacy" };
  }
  return { mode: "active", reason: "Active by default", source: "default" };
}

export function inactiveSourceTabs(policies = [], legacyExcluded = [], sourceKind = "") {
  const normalizedKind = normalizeSourceKind(sourceKind);
  const entries = parseSourceTabPolicies(policies)
    .filter((item) => item.mode !== "active" && (!normalizedKind || item.sourceKind === normalizedKind));
  const existing = new Set(entries.map((item) => sourceTabKey(item.sourceKind, item.sheetName)));
  for (const item of parseExcludedSheetTabs(legacyExcluded)) {
    if (normalizedKind && item.sourceKind !== normalizedKind) continue;
    const key = sourceTabKey(item.sourceKind, item.sheetName);
    if (!existing.has(key)) entries.push({ ...item, mode: "ignore" });
  }
  return entries;
}

export function sourceTabExclusion({ sourceKind, sheetName }, configured = []) {
  const systemReason = systemExcludedReason({ sourceKind, sheetName });
  if (systemReason) return { excluded: true, reason: systemReason, source: "system" };
  const key = sourceTabKey(sourceKind, sheetName);
  const configuredKeys = new Set(parseExcludedSheetTabs(configured).map((item) => sourceTabKey(item.sourceKind, item.sheetName)));
  return configuredKeys.has(key)
    ? { excluded: true, reason: "Excluded in Data Sources settings", source: "settings" }
    : { excluded: false, reason: "", source: "" };
}

export function sourceTabKey(sourceKind, sheetName) {
  return `${normalizeSourceKind(sourceKind)}|${normalizeText(sheetName)}`;
}

export function systemExcludedReason({ sheetName }) {
  const name = normalizeText(sheetName);
  if (name.startsWith("published videos with ads")) return "Non-test published-video inventory";
  return "";
}

function normalizeSourceKind(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["title", "thumbnail"].includes(text) ? text : "";
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
