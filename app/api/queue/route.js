import { requireSession } from "@/lib/auth.js";
import { applyChannelLogoFallbacks, loadConfiguredChannelLogos } from "@/lib/channel-logos.js";
import { getAppConfig } from "@/lib/config.js";
import {
  getConnectorStatus,
  listFinishSignalMatchCandidates,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { explainUnmatchedFinishEvent, suggestFinishEventMatches } from "@/lib/finish-events.mjs";
import { findYouTubeVideoCandidates } from "@/lib/youtube.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";
const YOUTUBE_LOOKUP_LIMIT_PER_QUEUE_LOAD = 12;

export async function GET() {
  try {
    await requireSession();
    const [runs, unmatchedEvents, connectorStatus, config, matchCandidates] = await Promise.all([
      listQueue(),
      listUnmatchedFinishEvents(),
      getConnectorStatus(),
      getAppConfig(),
      listFinishSignalMatchCandidates()
    ]);
    const channelLogos = await loadConfiguredChannelLogos(config);
    const unregisteredRuns = await buildUnregisteredRuns(unmatchedEvents, matchCandidates, config);
    const runsWithLogos = applyChannelLogoFallbacks([...runs, ...unregisteredRuns], channelLogos);
    return json({
      ok: true,
      runs: runsWithLogos,
      unmatchedEvents: [],
      connectorStatus,
      summary: summarizeQueue(runsWithLogos)
    });
  } catch (error) {
    return errorJson(error);
  }
}

async function buildUnregisteredRuns(events, matchCandidates, config) {
  let lookupCount = 0;
  return Promise.all(events.map(async (event) => {
    const shouldLookup = !event.videoId && event.videoTitle && lookupCount < YOUTUBE_LOOKUP_LIMIT_PER_QUEUE_LOAD;
    if (shouldLookup) lookupCount += 1;
    const youtubeCandidates = shouldLookup ? await findEventYouTubeCandidates(event, config) : [];
    return finishEventToUnregisteredRun(event, matchCandidates, youtubeCandidates);
  }));
}

async function findEventYouTubeCandidates(event, config) {
  if (event.videoId || !event.videoTitle || !config.youtubeApiKey) return [];
  return findYouTubeVideoCandidates({
    title: event.videoTitle,
    channel: event.channel,
    apiKey: config.youtubeApiKey,
    limit: 2
  }).catch(() => []);
}

function finishEventToUnregisteredRun(event, matchCandidates = [], youtubeCandidates = []) {
  const title = event.videoTitle || event.videoId || "Finished A/B test";
  const bestYoutubeCandidate = youtubeCandidates.find((item) => isStrongYoutubeCandidate(event, item)) || null;
  const enrichedEvent = bestYoutubeCandidate && !event.videoId
    ? { ...event, videoId: bestYoutubeCandidate.videoId }
    : event;
  const suggestions = suggestFinishEventMatches(enrichedEvent, matchCandidates, { limit: 2 });
  const highConfidenceSuggestion = suggestions.find((item) => item.confidence === "high");
  return {
    testRunId: `finish_event:${event.eventId}`,
    finishEventId: event.eventId,
    unregistered: true,
    videoId: enrichedEvent.videoId || "",
    inferredVideoId: bestYoutubeCandidate && !event.videoId ? bestYoutubeCandidate.videoId : "",
    sourceKind: "studio_signal",
    spreadsheetId: "",
    sheetName: "Not registered in A/B sheet",
    rowNumber: 0,
    testType: inferEventTestType(event),
    channel: event.channel || "Unknown source",
    videoTitle: title,
    videoUrl: enrichedEvent.videoId ? `https://www.youtube.com/watch?v=${enrichedEvent.videoId}` : "",
    studioUrl: enrichedEvent.videoId ? `https://studio.youtube.com/video/${enrichedEvent.videoId}/edit` : event.notificationUrl || "",
    startDate: "",
    finishDate: "",
    effectiveFinishDate: "",
    overdueDays: 0,
    status: "unregistered_signal",
    queueStatus: "confirmed_finished",
    detectedOutcome: event.detectedOutcome || "",
    suggestedWinner: "",
    winnerReason: "Studio finish signal found, but no matching row exists in the configured A/B sheet.",
    signalResolution: {
      state: suggestions.length ? "possible_match" : "not_registered",
      reason: explainUnmatchedFinishEvent(enrichedEvent, suggestions),
      suggestionCount: suggestions.length,
      bestSuggestion: highConfidenceSuggestion || suggestions[0] || null,
      suggestions,
      youtubeCandidates
    },
    options: {},
    watchTimeShare: {},
    troubles: [
      {
        severity: "warning",
        code: "not_registered_in_ab_sheet",
        message: "This finished Studio signal is not registered in the configured A/B sheet."
      }
    ],
    thumbnailPreviews: {},
    currentYoutubeTitle: bestYoutubeCandidate?.title || title,
    currentYoutubeThumbnailUrl: "",
    youtubeChannelTitle: event.channel || "",
    youtubeChannelThumbnailUrl: "",
    possibleRetest: false,
    driftedAt: "",
    driftReason: "",
    latestAction: "",
    latestActor: "",
    latestActionAt: "",
    finishEventSource: event.source || "studio_bell",
    finishEventText: bestYoutubeCandidate && !event.videoId
      ? `${event.rawText || ""}\n\nYouTube search candidate: ${bestYoutubeCandidate.title} (${bestYoutubeCandidate.videoId})`
      : event.rawText || "",
    finishEventUrl: event.notificationUrl || "",
    finishEventOutcome: event.detectedOutcome || "",
    finishEventAt: event.observedAt || "",
    matchedConfidence: "unregistered",
    connectorCovered: true,
    connectorLastSeenAt: event.observedAt || "",
    connectorActorName: event.actorName || ""
  };
}

function isStrongYoutubeCandidate(event, candidate) {
  const score = Number(candidate?.score || 0);
  if (score >= 0.95) return true;
  if (score >= 0.84 && relatedChannelName(event.channel, candidate.channel)) return true;
  return false;
}

function relatedChannelName(left, right) {
  const a = channelAliasKey(left);
  const b = channelAliasKey(right);
  return Boolean(a && b && a === b);
}

function channelAliasKey(channel) {
  const normalized = String(channel || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (["jotform", "jotform apps", "apps", "jotform sign", "sign"].includes(normalized)) return "jotform";
  return normalized;
}

function inferEventTestType(event) {
  const text = String(event.rawText || "").toLowerCase();
  if (text.includes("thumbnail")) return "thumbnail";
  return "title";
}
