import crypto from "node:crypto";

export function appManagedRunIdentity(event = {}, { now = new Date().toISOString() } = {}) {
  const testType = inferFinishEventTestType(event);
  const videoId = String(event.videoId || "").trim();
  const videoTitle = String(event.videoTitle || "").trim();
  const occurrence = String(event.occurredAt || event.observedAt || now).slice(0, 10);
  const identity = [videoId || normalizeText(videoTitle), testType, occurrence].join("|");
  const hash = crypto.createHash("sha1").update(identity).digest("hex");
  return {
    testRunId: `app_${hash.slice(0, 20)}`,
    identity,
    identityHash: hash,
    occurrence,
    testType
  };
}

export function inferFinishEventTestType(event = {}) {
  const text = `${event.testType || ""} ${event.rawText || ""}`.toLowerCase();
  return text.includes("thumbnail") ? "thumbnail" : "title";
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
