import crypto from "node:crypto";

export function appManagedRunIdentity(event = {}) {
  const testType = inferFinishEventTestType(event);
  const videoId = String(event.videoId || "").trim();
  const videoTitle = String(event.videoTitle || "").trim();
  const channel = String(event.channelId || event.channel || "").trim();
  // App-managed records have no authoritative test dates or option fingerprint.
  // Keep one registry record per video/type until a sheet row provides real run evidence.
  const identity = videoId
    ? [videoId, testType].join("|")
    : [normalizeText(videoTitle), testType, normalizeText(channel)].join("|");
  const hash = crypto.createHash("sha1").update(identity).digest("hex");
  return {
    testRunId: `app_${hash.slice(0, 20)}`,
    identity,
    identityHash: hash,
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
