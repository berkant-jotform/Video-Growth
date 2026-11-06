// Specific reviewer reasons retain the existing NO_CLEAR decision for reports.
// The reason is stored in the existing note field; no schema migration is needed.
export const REVIEW_OUTCOMES = [
  ["A", "A"], ["B", "B"], ["C", "C"],
  ["INSUFFICIENT_VIEWS", "Not enough viewers / views"],
  ["INSUFFICIENT_IMPRESSIONS", "Not enough impressions"],
  ["INSUFFICIENT_DATA", "Not enough data"],
  ["PERFORMED_SIMILARLY", "Performed similarly"],
  ["NO_WINNER", "No clear winner"],
  ["KEPT_CURRENT", "Kept current"],
  ["RETEST_LATER", "Retest later"]
];
const REASONS = new Map(REVIEW_OUTCOMES.slice(3, 8));
const PREFIX = "Review reason: ";

export function reviewOutcomeValue(action, note = "") {
  if (action === "NO_CLEAR") {
    const firstLine = String(note || "").split("\n")[0];
    for (const [value, label] of REASONS) {
      if (firstLine === PREFIX + label) return value;
    }
  }
  return action;
}

export function reviewActionLabel(action, note = "") {
  const value = reviewOutcomeValue(action, note);
  if (["A", "B", "C"].includes(value)) return `Selected ${value}`;
  if (value === "NO_CLEAR") return "Not enough views / No clear winner";
  return REVIEW_OUTCOMES.find(([key]) => key === value)?.[1]
    || String(value || "Done").replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export function normalizeReviewDecision(value, note = "") {
  const action = String(value || "").trim().toUpperCase();
  const label = REASONS.get(action);
  return {
    action: label ? "NO_CLEAR" : action,
    note: label ? `${PREFIX}${label}${note ? `\n${String(note)}` : ""}` : String(note || "")
  };
}

export function sameReviewDecision(previousAction, previousNote, action, note) {
  return previousAction === action &&
    reviewOutcomeValue(previousAction, previousNote) === reviewOutcomeValue(action, note);
}
