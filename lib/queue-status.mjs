export function deriveQueueStatus({
  drifted,
  hasAction,
  baseQueueStatus,
  startDate,
  latestAction = "",
  detectedOutcome = "",
  suggestedWinner = ""
}) {
  if (hasAction && isActionConflict({ latestAction, detectedOutcome, suggestedWinner, baseQueueStatus })) {
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

export function isActionConflict({ latestAction = "", detectedOutcome = "", suggestedWinner = "", baseQueueStatus = "" }) {
  const toolAction = normalizedOutcomeAction(latestAction);
  const sheetAction = sheetOutcomeAction({ detectedOutcome, suggestedWinner, baseQueueStatus });
  return Boolean(toolAction && sheetAction && toolAction !== sheetAction);
}

export function sheetOutcomeAction({ detectedOutcome = "", suggestedWinner = "", baseQueueStatus = "" }) {
  const status = String(baseQueueStatus || "").toLowerCase();
  if (!["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(status)) return "";
  const outcome = String(detectedOutcome || "").toLowerCase();
  if (outcome === "no_clear") return "NO_CLEAR";
  const outcomeWinner = outcome.match(/^winner_([abc])$/i)?.[1];
  if (outcomeWinner) return outcomeWinner.toUpperCase();
  return normalizedOutcomeAction(suggestedWinner);
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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.floor((today - date) / 86400000) >= 14;
}
