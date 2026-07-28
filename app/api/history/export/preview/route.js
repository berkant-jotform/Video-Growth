import { requireSession } from "@/lib/auth.js";
import { badRequest, errorJson, json } from "@/lib/http.js";
import { previewHistoryExport } from "@/lib/history-export-service.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => {
      throw badRequest("Export preview request must be valid JSON.");
    });
    const preview = await previewHistoryExport({
      request: body,
      actorName: session.actorName
    });
    return json({ ok: true, preview });
  } catch (error) {
    return errorJson(error);
  }
}
