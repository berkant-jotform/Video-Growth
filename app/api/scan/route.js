import { requireSession } from "@/lib/auth.js";
import { runScan } from "@/lib/scanner.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const result = await runScan({
      actorName: session.actorName,
      channel: body.channel || "all",
      testType: body.testType || "all",
      refreshThumbnails: Boolean(body.refreshThumbnails)
    });
    return json(result);
  } catch (error) {
    return errorJson(error);
  }
}
