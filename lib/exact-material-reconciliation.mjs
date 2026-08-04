const EXPLICIT_EVIDENCE = new Set(["studio_explicit", "sheet_explicit"]);
const CLOSED_STATUSES = new Set(["sheet_marked_done", "result_logged", "winner_found", "no_clear"]);

export function planExactMaterialReconciliation(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    if (!row?.testId || !row.videoId || !row.testType || !row.startDate || !row.optionFingerprint) continue;
    const key = [row.videoId, row.testType, row.startDate, row.optionFingerprint].join("|");
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const mappings = [];
  const ambiguous = [];
  for (const [materialKey, candidates] of groups) {
    const unique = dedupeByTestId(candidates);
    if (unique.length < 2) continue;

    const explicitOutcomes = new Set(
      unique
        .filter((row) => EXPLICIT_EVIDENCE.has(row.resultEvidence))
        .map((row) => `${row.result || "unknown"}:${row.explicitWinnerVariant || ""}`)
    );
    const actions = new Set(unique.flatMap((row) => row.activeActions || []).filter(Boolean));
    if (explicitOutcomes.size > 1 || actions.size > 1) {
      ambiguous.push({ materialKey, testIds: unique.map((row) => row.testId), reason: explicitOutcomes.size > 1 ? "conflicting_explicit_results" : "conflicting_reviewer_actions" });
      continue;
    }

    const ranked = [...unique].sort(compareCandidates);
    const target = ranked[0];
    for (const source of ranked.slice(1)) {
      mappings.push({ sourceTestId: source.testId, targetTestId: target.testId, materialKey });
    }
  }
  return { mappings, ambiguous };
}

function dedupeByTestId(rows) {
  const byId = new Map();
  for (const row of rows) {
    const existing = byId.get(row.testId);
    if (!existing || compareCandidates(row, existing) < 0) byId.set(row.testId, row);
  }
  return [...byId.values()];
}

function compareCandidates(left, right) {
  const scores = [
    actionScore,
    evidenceScore,
    closedScore,
    activeScore
  ];
  for (const score of scores) {
    const difference = score(right) - score(left);
    if (difference) return difference;
  }
  const updatedDifference = new Date(right.updatedAt || 0).valueOf() - new Date(left.updatedAt || 0).valueOf();
  if (updatedDifference) return updatedDifference;
  return String(left.testId).localeCompare(String(right.testId));
}

function actionScore(row) {
  return (row.activeActions || []).length ? 1 : 0;
}

function evidenceScore(row) {
  return EXPLICIT_EVIDENCE.has(row.resultEvidence) ? 1 : 0;
}

function closedScore(row) {
  return CLOSED_STATUSES.has(row.status) ? 1 : 0;
}

function activeScore(row) {
  return row.status === "source_removed" ? 0 : 1;
}
