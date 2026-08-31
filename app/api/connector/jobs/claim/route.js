import { requireConnector } from "@/lib/connector-auth.js";
import { claimConnectorScanJob } from "@/lib/connector-control.js";
import { updateConnectorDeviceIdentity } from "@/lib/connector-tokens.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const config = await requireConnector(request);
    const body = await request.json().catch(() => ({}));
    const connectorId = String(config.connectorDevice?.connectorId || body.connectorId || "").trim();
    if (config.connectorDevice?.tokenId) {
      await updateConnectorDeviceIdentity(config.connectorDevice.tokenId, {
        connectorId,
        capabilities: body.capabilities,
        version: body.version
      });
    }
    const job = await claimConnectorScanJob({ connectorId, requestedJobId: body.jobId || "" });
    return json({ ok: true, job });
  } catch (error) {
    return errorJson(error);
  }
}
