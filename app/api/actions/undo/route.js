import { requireSession } from "@/lib/auth.js";
import { undoReviewResolution, undoTestAction } from "@/lib/repository.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const actionId = String(body.actionId || "").trim();
    const resolutionId = String(body.resolutionId || "").trim();
    if (!actionId && !resolutionId) throw badRequest("Missing actionId or resolutionId.");
    const result = resolutionId
      ? await undoReviewResolution({ resolutionId, actorName: session.actorName })
      : await undoTestAction({ actionId, actorName: session.actorName });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorJson(error);
  }
}
