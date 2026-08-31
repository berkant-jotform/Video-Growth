import { formatDateOnly } from "./date-only.mjs";

export function deriveQueueStatus({
  drifted,
  hasAction,
  baseQueueStatus,
  startDate,
  latestAction = "",
  result = "unknown",
  resultEvidence = "unknown",
  explicitWinnerVariant = ""
}) {
  if (hasAction && isActionConflict({
    latestAction,
    result,
    resultEvidence,
    explicitWinnerVariant
  })) {
    return "action_conflict";
  }
  if (hasAction) {
    if (["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(baseQueueStatus)) {
      return baseQueueStatus;
    }
    return "done";
  }
  if (baseQueueStatus === "running" && isPastFourteenDays(startDate)) return "past_due_check";
  return baseQueueStatus;
}

export function resolveBaseQueueStatus({ rowStatus = "", finishEventStatus = "" } = {}) {
  if (["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(rowStatus)) {
    return rowStatus;
  }
  return finishEventStatus || (rowStatus === "needs_review" ? "confirmed_finished" : rowStatus);
}

export function isActionConflict({
  latestAction = "",
  result = "unknown",
  resultEvidence = "unknown",
  explicitWinnerVariant = ""
}) {
  const toolAction = normalizedOutcomeAction(latestAction);
  const explicitResultAction = explicitOutcomeAction({
    result,
    resultEvidence,
    explicitWinnerVariant
  });
  return Boolean(toolAction && explicitResultAction && toolAction !== explicitResultAction);
}

export function explicitOutcomeAction({
  result = "unknown",
  resultEvidence = "unknown",
  explicitWinnerVariant = ""
}) {
  if (!["studio_explicit", "sheet_explicit"].includes(String(resultEvidence || ""))) return "";
  if (String(result || "") !== "winner") return "";
  return normalizedOutcomeAction(explicitWinnerVariant);
}

export function normalizedOutcomeAction(value = "") {
  const text = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["A", "B", "C", "NO_CLEAR"].includes(text)) return text;
  if (/NO\s*CLEAR|NOT_ENOUGH|INCONCLUSIVE/i.test(String(value || ""))) return "NO_CLEAR";
  const single = String(value || "").trim().match(/^[ABC]$/i)?.[0];
  return single ? single.toUpperCase() : "";
}

export function isActionableQueueStatus(status = "") {
  return ["action_conflict", "confirmed_finished", "past_due_check"].includes(String(status || ""));
}

function isPastFourteenDays(dateValue) {
  if (!dateValue) return false;
  const datePart = String(dateValue).slice(0, 10);
  const date = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return false;
  const today = new Date(`${formatDateOnly(new Date())}T00:00:00Z`);
  return Math.floor((today - date) / 86400000) >= 14;
}
