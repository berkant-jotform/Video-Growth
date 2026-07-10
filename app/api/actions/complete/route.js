import { requireSession } from "@/lib/auth.js";
import { completeTestRun, resolveReviewItem } from "@/lib/repository.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

const ALLOWED_ACTIONS = new Set(["A", "B", "C", "NO_CLEAR", "KEPT_CURRENT", "RETEST_LATER", "SKIP"]);

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const testRunId = String(body.testRunId || "").trim();
    const action = String(body.action || "").trim().toUpperCase();
    if (!testRunId) throw badRequest("Missing testRunId.");
    if (!ALLOWED_ACTIONS.has(action)) throw badRequest("Unsupported action.");
    if (testRunId.startsWith("finish_event:")) {
      const eventId = testRunId.slice("finish_event:".length);
      if (!eventId) throw badRequest("Missing finish event id.");
      const resolution = await resolveReviewItem({
        targetType: "finish_event",
        targetId: eventId,
        action,
        actorName: session.actorName,
        note: body.note || "",
        metadata: { source: "unregistered_finish_signal", testRunId }
      });
      return json({ ok: true, test: { testRunId, latestAction: action, resolution }, resolutionId: resolution.resolutionId });
    }
    const result = await completeTestRun({
      testRunId,
      action,
      actorName: session.actorName,
      note: body.note || "",
      retestConfirmed: Boolean(body.retestConfirmed)
    });
    return json({ ok: true, test: result.test, actionId: result.actionId, duplicate: result.duplicate });
  } catch (error) {
    return errorJson(error);
  }
}
