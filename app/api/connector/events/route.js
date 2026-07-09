import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { getAppConfig } from "@/lib/config.js";
import { recordConnectorEvents, recordDiagnosticLog } from "@/lib/repository.js";
import { expandConnectorEventInputs } from "@/lib/finish-events.mjs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireConnector(request);
    const body = await request.json();
    const rawEvents = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
    const events = expandConnectorEventInputs(rawEvents);
    if (!events.length) {
      const error = new Error("No connector events were provided.");
      error.status = 400;
      throw error;
    }
    const config = await getAppConfig();
    const results = await recordConnectorEvents({
      events,
      actorName: body.actorName || body.reviewerInitials || "",
      connectorId: body.connectorId || "",
      source: body.source || "studio_bell",
      youtubeApiKey: config.youtubeApiKey,
      channelScope: body.channelScope || [],
      testTypeScope: body.testTypeScope || "all"
    });
    await recordDiagnosticLog({
      category: "connector_events",
      severity: results.some((item) => item.processingStatus === "matched") ? "info" : "warning",
      message: "Connector events received",
      actorName: body.actorName || body.reviewerInitials || "",
      context: {
        connectorId: body.connectorId || "",
        source: body.source || "studio_bell",
        received: rawEvents.length,
        expanded: events.length,
        matched: results.filter((item) => item.processingStatus === "matched").length,
        unmatched: results.filter((item) => item.processingStatus === "unmatched").length,
        ignored: results.filter((item) => item.processingStatus === "ignored").length,
        youtubeResolved: results.filter((item) => item.youtubeResolved).length,
        previews: events.slice(0, 5).map((event) => ({
          videoId: event.videoId || "",
          channel: event.channel || "",
          videoTitle: event.videoTitle || "",
          rawText: String(event.rawText || "").slice(0, 240)
        }))
      }
    });
    return json({
      ok: true,
      received: events.length,
      rawReceived: rawEvents.length,
      matched: results.filter((item) => item.processingStatus === "matched").length,
      unmatched: results.filter((item) => item.processingStatus === "unmatched").length,
      ignored: results.filter((item) => item.processingStatus === "ignored").length,
      youtubeResolved: results.filter((item) => item.youtubeResolved).length,
      results
    });
  } catch (error) {
    await recordDiagnosticLog({
      category: "connector_events",
      severity: "error",
      message: "Connector events failed",
      context: { error: error.message }
    });
    return errorJson(error);
  }
}
