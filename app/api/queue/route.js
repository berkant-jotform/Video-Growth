import { requireSession } from "@/lib/auth.js";
import {
  getConnectorStatus,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const [runs, unmatchedEvents, connectorStatus] = await Promise.all([
      listQueue(),
      listUnmatchedFinishEvents(),
      getConnectorStatus()
    ]);
    return json({
      ok: true,
      runs,
      unmatchedEvents,
      connectorStatus,
      summary: summarizeQueue(runs)
    });
  } catch (error) {
    return errorJson(error);
  }
}
