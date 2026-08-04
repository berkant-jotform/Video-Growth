import { requireSession } from "@/lib/auth.js";
import { requestScanCancellation } from "@/lib/repository.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const scanId = String(body.scanId || "").trim();
    if (!scanId) throw badRequest("A current scan ID is required to stop a scan safely.");
    const result = await requestScanCancellation({
      scanId,
      actorName: session.actorName
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorJson(error);
  }
}
