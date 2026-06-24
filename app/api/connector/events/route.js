import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { recordConnectorEvents } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireConnector(request);
    const body = await request.json();
    const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
    if (!events.length) {
      const error = new Error("No connector events were provided.");
      error.status = 400;
      throw error;
    }
    const results = await recordConnectorEvents({
      events,
      actorName: body.actorName || body.reviewerInitials || "",
      connectorId: body.connectorId || "",
      source: body.source || "studio_bell"
    });
    return json({
      ok: true,
      received: events.length,
      matched: results.filter((item) => item.processingStatus === "matched").length,
      unmatched: results.filter((item) => item.processingStatus === "unmatched").length,
      results
    });
  } catch (error) {
    return errorJson(error);
  }
}
