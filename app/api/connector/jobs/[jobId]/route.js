import { requireConnector } from "@/lib/connector-auth.js";
import { getConnectorScanJob, updateConnectorScanJob } from "@/lib/connector-control.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  try {
    const config = await requireConnector(request);
    const { jobId } = await params;
    const job = await getConnectorScanJob(jobId);
    if (!job) return json({ ok: false, error: "Extension check was not found." }, { status: 404 });
    const connectorId = config.connectorDevice?.connectorId || new URL(request.url).searchParams.get("connectorId") || "";
    if (job.claimedBy && connectorId && job.claimedBy !== connectorId) {
      return json({ ok: false, error: "This check belongs to another browser." }, { status: 403 });
    }
    return json({ ok: true, job }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorJson(error);
  }
}

export async function PATCH(request, { params }) {
  try {
    const config = await requireConnector(request);
    const body = await request.json().catch(() => ({}));
    const { jobId } = await params;
    const connectorId = String(config.connectorDevice?.connectorId || body.connectorId || "").trim();
    const job = await updateConnectorScanJob(jobId, connectorId, body);
    return job
      ? json({ ok: true, job })
      : json({ ok: false, error: "Extension check was not found or belongs to another browser." }, { status: 404 });
  } catch (error) {
    return errorJson(error);
  }
}
