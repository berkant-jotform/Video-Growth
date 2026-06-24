import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { parseConnectorChannels } from "@/lib/finish-events.mjs";
import { recordConnectorHeartbeat } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireConnector(request);
    const body = await request.json();
    const status = await recordConnectorHeartbeat({
      connectorId: body.connectorId || "",
      actorName: body.actorName || body.reviewerInitials || "",
      channels: parseConnectorChannels(body.channels || []),
      version: body.version || "",
      status: body.status || "online",
      payload: {
        location: body.location || "",
        userAgent: body.userAgent || "",
        observedAt: body.observedAt || new Date().toISOString()
      }
    });
    return json({ ok: true, connectorStatus: status });
  } catch (error) {
    return errorJson(error);
  }
}
