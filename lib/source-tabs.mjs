export const EXCLUDED_SHEET_TABS_KEY = "EXCLUDED_SHEET_TABS_JSON";

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
