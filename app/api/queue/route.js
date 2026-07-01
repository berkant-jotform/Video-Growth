import { requireSession } from "@/lib/auth.js";
import { applyChannelLogoFallbacks, loadConfiguredChannelLogos } from "@/lib/channel-logos.js";
import { getAppConfig } from "@/lib/config.js";
import {
  getConnectorStatus,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const [runs, unmatchedEvents, connectorStatus, config] = await Promise.all([
      listQueue(),
      listUnmatchedFinishEvents(),
      getConnectorStatus(),
      getAppConfig()
    ]);
    const channelLogos = await loadConfiguredChannelLogos(config);
    const unregisteredRuns = unmatchedEvents.map(finishEventToUnregisteredRun);
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

function finishEventToUnregisteredRun(event) {
  const title = event.videoTitle || event.videoId || "Finished A/B test";
  return {
    testRunId: `finish_event:${event.eventId}`,
    finishEventId: event.eventId,
    unregistered: true,
    videoId: event.videoId || "",
    sourceKind: "studio_signal",
    spreadsheetId: "",
    sheetName: "Not registered in A/B sheet",
    rowNumber: 0,
    testType: inferEventTestType(event),
    channel: event.channel || "Unknown source",
    videoTitle: title,
    videoUrl: event.videoId ? `https://www.youtube.com/watch?v=${event.videoId}` : "",
    studioUrl: event.notificationUrl || (event.videoId ? `https://studio.youtube.com/video/${event.videoId}/edit` : ""),
    startDate: "",
    finishDate: "",
    effectiveFinishDate: "",
    overdueDays: 0,
    status: "unregistered_signal",
    queueStatus: "confirmed_finished",
    detectedOutcome: event.detectedOutcome || "",
    suggestedWinner: "",
    winnerReason: "Studio finish signal found, but no matching row exists in the configured A/B sheet.",
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
    currentYoutubeTitle: title,
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
    finishEventText: event.rawText || "",
    finishEventUrl: event.notificationUrl || "",
    finishEventOutcome: event.detectedOutcome || "",
    finishEventAt: event.observedAt || "",
    matchedConfidence: "unregistered",
    connectorCovered: true,
    connectorLastSeenAt: event.observedAt || "",
    connectorActorName: event.actorName || ""
  };
}

function inferEventTestType(event) {
  const text = String(event.rawText || "").toLowerCase();
  if (text.includes("thumbnail")) return "thumbnail";
  return "title";
}
