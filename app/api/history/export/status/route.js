import { requireSession } from "@/lib/auth.js";
import { errorJson, json } from "@/lib/http.js";
import { historyExportStatus, recentHistoryExports } from "@/lib/history-export-service.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const status = await historyExportStatus();
    const recent = status.enabled ? await recentHistoryExports() : [];
    return json({ ok: true, ...status, recent });
  } catch (error) {
    return errorJson(error);
  }
}
