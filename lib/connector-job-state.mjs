export const CONNECTOR_JOB_MAX_ATTEMPTS = 3;

export function connectorJobRecoveryDecision(job = {}, maxAttempts = CONNECTOR_JOB_MAX_ATTEMPTS) {
  const status = String(job.status || "").toLowerCase();
  const attemptCount = Math.max(0, Number(job.attemptCount || 0));
  if (status === "cancel_requested") return "cancelled";
  if (!["claimed", "running"].includes(status)) return "unchanged";
  return attemptCount < maxAttempts ? "retry" : "failed";
}
