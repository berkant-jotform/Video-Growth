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
    const spreadsheetId = String(item?.spreadsheetId || "").trim();
    const externalTabId = String(item?.externalTabId || item?.sheetId || "").trim();
    const sheetName = String(item?.sheetName || item?.title || "").trim();
    const mode = String(item?.mode || "active").trim().toLowerCase();
    if (!sourceKind || !sheetName) continue;
    if (!SOURCE_TAB_MODES.includes(mode)) {
      throw new Error(`Unsupported source tab mode "${mode}" for "${sheetName}".`);
    }
    const normalized = { sourceKind, sheetName, mode };
    if (spreadsheetId) normalized.spreadsheetId = spreadsheetId;
    if (externalTabId) normalized.externalTabId = externalTabId;
    byKey.set(sourceTabKey(sourceKind, sheetName, spreadsheetId, externalTabId), normalized);
  }
  return Array.from(byKey.values());
}

export function stringifySourceTabPolicies(entries = []) {
  return JSON.stringify(parseSourceTabPolicies(entries), null, 2);
}

export function sourceTabPolicy(context = {}, policies = [], legacyExcluded = []) {
  const { sourceKind, sheetName } = context;
  const systemReason = systemExcludedReason(context);
  if (systemReason) return { mode: "ignore", reason: systemReason, source: "system" };
  const configured = parseSourceTabPolicies(policies)
    .filter((item) => policyMatchesTab(item, context))
    .sort((left, right) => policySpecificity(right) - policySpecificity(left))[0];
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
  if (legacyKeys.has(sourceTabKey(sourceKind, sheetName))) {
    return { mode: "ignore", reason: "Ignored by legacy excluded-tab setting", source: "legacy" };
  }
  return { mode: "active", reason: "Active by default", source: "default" };
}

export function inactiveSourceTabs(policies = [], legacyExcluded = [], sourceKind = "") {
  const normalizedKind = normalizeSourceKind(sourceKind);
  const configured = parseSourceTabPolicies(policies);
  const entries = configured
    .filter((item) => item.mode !== "active" && (!normalizedKind || item.sourceKind === normalizedKind));
  const existing = new Set(entries.map((item) => sourceTabKey(item.sourceKind, item.sheetName, item.spreadsheetId, item.externalTabId)));
  for (const item of parseExcludedSheetTabs(legacyExcluded)) {
    if (normalizedKind && item.sourceKind !== normalizedKind) continue;
    if (configured.some((policy) =>
      policy.sourceKind === item.sourceKind && normalizeText(policy.sheetName) === normalizeText(item.sheetName)
    )) continue;
    const key = sourceTabKey(item.sourceKind, item.sheetName, item.spreadsheetId, item.externalTabId);
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

export function sourceTabKey(sourceKind, sheetName, spreadsheetId = "", externalTabId = "") {
  const kind = normalizeSourceKind(sourceKind);
  const workbook = String(spreadsheetId || "").trim();
  const tabId = String(externalTabId || "").trim();
  if (workbook && tabId) return `${kind}|workbook:${workbook}|tab:${tabId}`;
  if (workbook) return `${kind}|workbook:${workbook}|name:${normalizeText(sheetName)}`;
  return `${kind}|name:${normalizeText(sheetName)}`;
}

export function sourceTabLookupKeys(sourceKind, sheetName, spreadsheetId = "", externalTabId = "") {
  return Array.from(new Set([
    sourceTabKey(sourceKind, sheetName, spreadsheetId, externalTabId),
    sourceTabKey(sourceKind, sheetName, spreadsheetId, ""),
    sourceTabKey(sourceKind, sheetName)
  ]));
}

export function changedSourceTabPolicies(previous = [], next = []) {
  const previousByKey = new Map(parseSourceTabPolicies(previous).map((item) => [
    sourceTabKey(item.sourceKind, item.sheetName, item.spreadsheetId, item.externalTabId),
    item
  ]));
  const nextByKey = new Map(parseSourceTabPolicies(next).map((item) => [
    sourceTabKey(item.sourceKind, item.sheetName, item.spreadsheetId, item.externalTabId),
    item
  ]));
  return Array.from(new Set([...previousByKey.keys(), ...nextByKey.keys()])).map((key) => {
    const item = nextByKey.get(key) || previousByKey.get(key);
    return {
      sourceKind: item.sourceKind,
      spreadsheetId: item.spreadsheetId || "",
      externalTabId: item.externalTabId || "",
      sheetName: item.sheetName,
      mode: nextByKey.get(key)?.mode || "active"
    };
  });
}

function policyMatchesTab(policy, tab) {
  if (normalizeSourceKind(policy.sourceKind) !== normalizeSourceKind(tab.sourceKind)) return false;
  const policyWorkbook = String(policy.spreadsheetId || "").trim();
  const tabWorkbook = String(tab.spreadsheetId || "").trim();
  if (policyWorkbook && policyWorkbook !== tabWorkbook) return false;
  const policyTabId = String(policy.externalTabId || "").trim();
  const tabId = String(tab.externalTabId || tab.sheetId || "").trim();
  if (policyTabId) return Boolean(tabId && policyTabId === tabId);
  return normalizeText(policy.sheetName) === normalizeText(tab.sheetName);
}

function policySpecificity(policy) {
  if (policy.externalTabId && policy.spreadsheetId) return 3;
  if (policy.spreadsheetId) return 2;
  return 1;
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
