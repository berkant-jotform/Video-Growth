import { claimConnectorPairing } from "@/lib/connector-control.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!String(body.code || "").startsWith("ytab_pair_")) throw badRequest("Invalid or expired browser pairing request.");
    const device = await claimConnectorPairing({
      code: body.code,
      connectorId: body.connectorId,
      deviceLabel: body.deviceLabel,
      version: body.version,
      capabilities: body.capabilities
    });
    if (!device) return json({ ok: false, error: "This pairing request expired or was already used." }, { status: 410 });
    return json({ ok: true, device });
  } catch (error) {
    return errorJson(error);
  }
}
