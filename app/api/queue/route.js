import { requireSession } from "@/lib/auth.js";
import { listQueue, summarizeQueue } from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const runs = await listQueue();
    return json({ ok: true, runs, summary: summarizeQueue(runs) });
  } catch (error) {
    return errorJson(error);
  }
}
