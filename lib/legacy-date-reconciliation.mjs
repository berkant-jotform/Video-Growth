const LEGACY_YEAR_CUTOFF = 2005;
const PLAUSIBLE_YEAR_FLOOR = 2020;

export function planLegacyYearlessDateReconciliation(rows = []) {
  const candidatesByLegacyRun = new Map();

  for (const row of rows) {
    if (!isEligiblePair(row)) continue;
    const candidates = candidatesByLegacyRun.get(row.legacyRunId) || [];
    candidates.push(row);
    candidatesByLegacyRun.set(row.legacyRunId, candidates);
  }

  const proposed = [];
  const ambiguous = [];
  for (const [legacyRunId, candidates] of candidatesByLegacyRun) {
    const targetTestIds = new Set(candidates.map((row) => row.targetTestId).filter(Boolean));
    if (targetTestIds.size !== 1) {
      ambiguous.push({ legacyRunId, targetTestIds: [...targetTestIds] });
      continue;
    }
    const ranked = [...candidates].sort(compareCandidates);
    proposed.push(ranked[0]);
  }

  const targetByLegacyTest = new Map();
  for (const row of proposed) {
    const targets = targetByLegacyTest.get(row.legacyTestId) || new Set();
    targets.add(row.targetTestId);
    targetByLegacyTest.set(row.legacyTestId, targets);
  }

  const mappings = [];
  for (const row of proposed) {
    const targets = targetByLegacyTest.get(row.legacyTestId);
    if (targets?.size !== 1) {
      ambiguous.push({ legacyRunId: row.legacyRunId, targetTestIds: [...(targets || [])] });
      continue;
    }
    mappings.push({
      legacyRunId: row.legacyRunId,
      legacyTestId: row.legacyTestId,
      targetRunId: row.targetRunId,
      targetTestId: row.targetTestId
    });
  }

  return { mappings, ambiguous };
}

function isEligiblePair(row) {
  if (!row?.legacyRunId || !row?.targetRunId || row.legacyRunId === row.targetRunId) return false;
  if (!row.legacyTestId || !row.targetTestId) return false;
  if (!row.videoId || !row.testType || !row.optionFingerprint) return false;
  const legacy = dateParts(row.legacyStartDate);
  const target = dateParts(row.targetStartDate);
  if (!legacy || !target) return false;
  if (legacy.year >= LEGACY_YEAR_CUTOFF || target.year < PLAUSIBLE_YEAR_FLOOR) return false;
  return legacy.month === target.month && legacy.day === target.day;
}

function compareCandidates(left, right) {
  const status = (value) =>
    ["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(value) ? 1 : 0;
  const statusDifference = status(right.targetStatus) - status(left.targetStatus);
  if (statusDifference) return statusDifference;
  return new Date(right.targetUpdatedAt || 0).valueOf() - new Date(left.targetUpdatedAt || 0).valueOf();
}

function dateParts(value) {
  if (!value) return null;
  const match = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
