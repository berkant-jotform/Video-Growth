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

export function sameAppManagedDecisionIdentity(left = {}, right = {}) {
  if (String(left.testType || "") !== String(right.testType || "")) return false;
  const leftVideoId = String(left.videoId || "").trim();
  const rightVideoId = String(right.videoId || "").trim();
  if (leftVideoId && rightVideoId) return leftVideoId === rightVideoId;

  const leftTitle = normalizeText(left.currentYoutubeTitle || left.videoTitle);
  const rightTitle = normalizeText(right.currentYoutubeTitle || right.videoTitle);
  if (!leftTitle || leftTitle !== rightTitle) return false;

  const leftChannel = normalizeText(left.youtubeChannelId || left.youtubeChannelTitle || left.channel);
  const rightChannel = normalizeText(right.youtubeChannelId || right.youtubeChannelTitle || right.channel);
  if (!leftChannel || !rightChannel) return true;
  return leftChannel === rightChannel;
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
