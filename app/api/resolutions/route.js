import { requireSession } from "@/lib/auth.js";
import { badRequest, errorJson, json } from "@/lib/http.js";
import { matchFinishEventToTestRun, resolveReviewItem } from "@/lib/repository.js";

export const runtime = "nodejs";

const ALLOWED_TARGET_TYPES = new Set(["test_run", "finish_event"]);
const ALLOWED_ACTIONS = new Set(["ignore", "match"]);

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const targetType = String(body.targetType || "").trim();
    const targetId = String(body.targetId || "").trim();
    const action = String(body.action || "ignore").trim();
    if (!ALLOWED_TARGET_TYPES.has(targetType)) throw badRequest("Unsupported resolution target.");
    if (!targetId) throw badRequest("Missing targetId.");
    if (!ALLOWED_ACTIONS.has(action)) throw badRequest("Unsupported resolution action.");
    if (action === "match") {
      if (targetType !== "finish_event") throw badRequest("Only finish signals can be matched.");
      const testRunId = String(body.testRunId || body.metadata?.testRunId || "").trim();
      if (!testRunId) throw badRequest("Missing testRunId.");
      const match = await matchFinishEventToTestRun({
        eventId: targetId,
        testRunId,
        actorName: session.actorName,
        note: body.note || ""
      });
      return json({ ok: true, match });
    }
    const resolution = await resolveReviewItem({
      targetType,
      targetId,
      action,
      actorName: session.actorName,
      note: body.note || "",
      metadata: body.metadata || {}
    });
    return json({ ok: true, resolution });
  } catch (error) {
    return errorJson(error);
  }
}
