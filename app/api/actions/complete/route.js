import { requireSession } from "@/lib/auth.js";
import { completeTestRun } from "@/lib/repository.js";
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
    const test = await completeTestRun({
      testRunId,
      action,
      actorName: session.actorName,
      note: body.note || "",
      retestConfirmed: Boolean(body.retestConfirmed)
    });
    return json({ ok: true, test });
  } catch (error) {
    return errorJson(error);
  }
}
