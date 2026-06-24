import { requireSession } from "@/lib/auth.js";
import { runScan } from "@/lib/scanner.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    const session = await requireSession();
    const result = await runScan({ actorName: session.actorName });
    return json(result);
  } catch (error) {
    return errorJson(error);
  }
}
