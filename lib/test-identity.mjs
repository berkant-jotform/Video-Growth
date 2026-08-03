import crypto from "node:crypto";

export const TEST_ID_PREFIX = "test_";
export const IDENTITY_VERSION = "1";

export function createTestId(randomUUID = crypto.randomUUID) {
  return `${TEST_ID_PREFIX}${randomUUID()}`;
}

export function testContentHash(record = {}) {
  return sha256(stableStringify({
    identityVersion: IDENTITY_VERSION,
    videoId: String(record.videoId || "").trim(),
    testType: String(record.testType || "").trim(),
    startDate: dateOnly(record.startDate),
    options: normalizeOptions(record.options)
  }));
}

export function sourceLocationAlias(record = {}) {
  const spreadsheetId = String(record.spreadsheetId || "").trim();
  const sheetName = String(record.sheetName || "").trim();
  const rowNumber = Number(record.rowNumber || 0);
  const sourceKind = String(record.sourceKind || "").trim();
  if (!spreadsheetId || !sheetName || !rowNumber || !sourceKind) return "";
  return `sheet:${sourceKind}:${spreadsheetId}:${normalizeText(sheetName)}:${rowNumber}`;
}

export function contentAlias(record = {}) {
  const videoId = String(record.videoId || "").trim();
  const testType = String(record.testType || "").trim();
  const hash = String(record.contentHash || testContentHash(record));
  if (!videoId || !testType || !hash) return "";
  return `content:${videoId}:${testType}:${hash}`;
}

export function datedVideoAlias(record = {}) {
  const videoId = String(record.videoId || "").trim();
  const testType = String(record.testType || "").trim();
  const startDate = dateOnly(record.startDate);
  if (!videoId || !testType || !startDate) return "";
  return `video-date:${videoId}:${testType}:${startDate}`;
}

export function identityAliases(record = {}) {
  return Array.from(new Set([
    sourceLocationAlias(record),
    datedVideoAlias(record),
    contentAlias(record)
  ].filter(Boolean)));
}

export function resolvePersistedTestId({
  record,
  aliasToTestId = new Map(),
  aliasTargets = new Map(),
  existingTests = [],
  createId = createTestId
} = {}) {
  const aliases = identityAliases(record);
  const compatibleAliases = aliases.filter((alias) =>
    aliasTargetIsCompatible({ alias, record, target: aliasTargets.get(alias) })
  );
  const aliasMatches = Array.from(new Set(
    compatibleAliases.map((alias) => aliasToTestId.get(alias)).filter(Boolean)
  ));
  if (aliasMatches.length === 1) {
    return { testId: aliasMatches[0], match: "alias", aliases, ambiguous: false };
  }
  if (aliasMatches.length > 1) {
    const strongMatches = Array.from(new Set(
      compatibleAliases
        .filter((alias) => !alias.startsWith("sheet:"))
        .map((alias) => aliasToTestId.get(alias))
        .filter(Boolean)
    ));
    if (strongMatches.length === 1) {
      return {
        testId: strongMatches[0],
        match: "strong_alias_over_stale_location",
        aliases,
        ambiguous: false
      };
    }
    return {
      testId: "",
      match: "ambiguous_alias",
      aliases,
      ambiguous: true,
      conflictingTestIds: aliasMatches
    };
  }

  const videoId = String(record?.videoId || "").trim();
  const testType = String(record?.testType || "").trim();
  const startDate = dateOnly(record?.startDate);
  const contentHash = String(record?.contentHash || testContentHash(record));
  const candidates = (existingTests || []).filter((test) => {
    if (!videoId || test.videoId !== videoId || test.testType !== testType) return false;
    if (startDate && dateOnly(test.startDate) === startDate) return true;
    return Boolean(contentHash && test.contentHash === contentHash);
  });
  const candidateIds = Array.from(new Set(candidates.map((test) => test.testId).filter(Boolean)));
  if (candidateIds.length === 1) {
    return { testId: candidateIds[0], match: "existing_test", aliases, ambiguous: false };
  }
  if (candidateIds.length > 1) {
    return {
      testId: "",
      match: "ambiguous_existing",
      aliases,
      ambiguous: true,
      conflictingTestIds: candidateIds
    };
  }
  return { testId: createId(), match: "new", aliases, ambiguous: false };
}

function aliasTargetIsCompatible({ alias, record, target }) {
  if (!alias.startsWith("sheet:") || !target) return true;
  const videoId = String(record?.videoId || "").trim();
  const testType = String(record?.testType || "").trim();
  const targetVideoId = String(target.videoId || "").trim();
  const targetTestType = String(target.testType || "").trim();
  if (videoId && targetVideoId && videoId !== targetVideoId) return false;
  if (testType && targetTestType && testType !== targetTestType) return false;
  return true;
}

export function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function normalizeOptions(options = {}) {
  return Object.fromEntries(
    ["A", "B", "C"]
      .map((variant) => [variant, normalizeText(options?.[variant])])
      .filter(([, value]) => value)
  );
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortDeep(item)])
    );
  }
  return value;
}
