import { requireSession } from "@/lib/auth.js";
import { applyChannelLogoFallbacks, loadConfiguredChannelLogos } from "@/lib/channel-logos.js";
import { canonicalChannelName } from "@/lib/channels.mjs";
import { getAppConfig } from "@/lib/config.js";
import {
  getConnectorStatus,
  listFinishSignalMatchCandidates,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { consolidateUnmatchedFinishEvents, explainUnmatchedFinishEvent, parseStudioNotification, suggestFinishEventMatches } from "@/lib/finish-events.mjs";
import { errorJson, json } from "@/lib/http.js";
import { fetchYouTubeVideoMetadata } from "@/lib/youtube.js";

export const runtime = "nodejs";

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
    const consolidatedEvents = consolidateUnmatchedFinishEvents(unmatchedEvents).events;
    const unregisteredMetadata = await fetchYouTubeVideoMetadata(
      consolidatedEvents.map((event) => event.videoId),
      config.youtubeApiKey
    );
    const enrichedEvents = consolidatedEvents.map((event) => enrichUnregisteredEvent(event, unregisteredMetadata));
    const unregisteredRuns = buildUnregisteredRuns(enrichedEvents, matchCandidates);
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

function buildUnregisteredRuns(events, matchCandidates) {
  return events.map((event) =>
    finishEventToUnregisteredRun(event, matchCandidates, event.youtubeCandidates || [])
  );
}

function enrichUnregisteredEvent(event, metadata) {
  const item = metadata[event.videoId];
  if (!item) return event;
  return {
    ...event,
    videoTitle: event.videoTitle || item.title || "",
    channel: canonicalChannelName(item.channelTitle || event.channel) || item.channelTitle || event.channel || "",
    channelId: event.channelId || item.channelId || "",
    youtubeMetadata: item
  };
}

function finishEventToUnregisteredRun(event, matchCandidates = [], youtubeCandidates = []) {
  const bestYoutubeCandidate = youtubeCandidates.find((item) => isStrongYoutubeCandidate(event, item)) || null;
  const reparsedEvent = parseStudioNotification(event);
  const title = event.videoTitle || reparsedEvent.videoTitle || bestYoutubeCandidate?.title || event.videoId || "Finished A/B test";
  const knownChannelRun = event.channelId
    ? matchCandidates.find((run) => run.youtubeChannelId && run.youtubeChannelId === event.channelId)
    : null;
  const rawChannel = String(event.channel || "").trim();
  const resolvedChannel = rawChannel && !/^(?:account|channel|unknown source)$/i.test(rawChannel)
    ? rawChannel
    : bestYoutubeCandidate?.channel || knownChannelRun?.youtubeChannelTitle || knownChannelRun?.channel || "Unknown source";
  const channel = canonicalChannelName(resolvedChannel) || resolvedChannel;
  const enrichedEvent = {
    ...reparsedEvent,
    ...event,
    videoTitle: title,
    videoId: event.videoId || bestYoutubeCandidate?.videoId || ""
  };
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
    channel,
    youtubeChannelId: enrichedEvent.channelId || bestYoutubeCandidate?.channelId || knownChannelRun?.youtubeChannelId || "",
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
    currentYoutubeThumbnailUrl: event.youtubeMetadata?.thumbnailUrl || "",
    youtubeChannelTitle: channel === "Unknown source" ? "" : channel,
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
    finishEventNotificationAge: notificationAgeLabel(event.notificationAge),
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

function notificationAgeLabel(value) {
  if (!value) return "";
  if (typeof value === "object") {
    if (value.label) return String(value.label);
    if (Number.isFinite(Number(value.days))) {
      const days = Number(value.days);
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    return "";
  }
  const text = String(value);
  if (text.startsWith("{")) {
    try {
      return notificationAgeLabel(JSON.parse(text));
    } catch {}
  }
  return text;
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
  if (["jotform apps", "apps"].includes(normalized)) return "apps";
  if (["jotform sign", "sign"].includes(normalized)) return "sign";
  return normalized;
}

function inferEventTestType(event) {
  const text = String(event.rawText || "").toLowerCase();
  if (text.includes("thumbnail")) return "thumbnail";
  return "title";
}
