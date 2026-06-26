export function deriveQueueStatus({ drifted, hasAction, baseQueueStatus, startDate }) {
  if (drifted && hasAction && !isSheetCompletedStatus(baseQueueStatus)) return "sheet_changed_after_done";
  if (baseQueueStatus === "running" && isPastFourteenDays(startDate)) return "past_due_check";
  return baseQueueStatus;
}

function isSheetCompletedStatus(status) {
  return ["sheet_marked_done", "result_logged", "winner_found", "no_clear"].includes(status);
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
