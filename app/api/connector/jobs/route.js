import { requireSession } from "@/lib/auth.js";
import {
  createConnectorScanJob,
  getConnectorScanJob,
  listConnectorScanJobs,
  requestConnectorScanJobCancellation
} from "@/lib/connector-control.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireSession();
    const params = new URL(request.url).searchParams;
    const jobId = params.get("jobId") || "";
    if (jobId) {
      const job = await getConnectorScanJob(jobId);
      return job
        ? json({ ok: true, job }, { headers: { "Cache-Control": "private, no-store" } })
        : json({ ok: false, error: "Extension check was not found." }, { status: 404 });
    }
    const jobs = await listConnectorScanJobs({ limit: params.get("limit") || 20 });
    return json({ ok: true, jobs }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const job = await createConnectorScanJob({
      actorName: session.actorName,
      targetConnectorId: body.targetConnectorId || "",
      channels: body.channels || [],
      testType: body.testType || "all",
      mode: body.mode || "notifications"
    });
    return json({ ok: true, job });
  } catch (error) {
    return errorJson(error);
  }
}

export async function DELETE(request) {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({}));
    if (!body.jobId) throw badRequest("Missing extension check ID.");
    const job = await requestConnectorScanJobCancellation(body.jobId);
    return job
      ? json({ ok: true, job })
      : json({ ok: false, error: "Extension check was not found." }, { status: 404 });
  } catch (error) {
    return errorJson(error);
  }
}
