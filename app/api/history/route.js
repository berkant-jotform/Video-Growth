import { requireSession } from "@/lib/auth.js";
import { listHistory } from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireSession();
    const search = new URL(request.url).searchParams.get("q") || "";
    const items = await listHistory({ search });
    return json({ ok: true, items });
  } catch (error) {
    return errorJson(error);
  }
}
