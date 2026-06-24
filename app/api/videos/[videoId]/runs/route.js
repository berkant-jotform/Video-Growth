import { requireSession } from "@/lib/auth.js";
import { listRunsForVideo } from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(_request, { params }) {
  try {
    await requireSession();
    const resolved = await params;
    const runs = await listRunsForVideo(resolved.videoId);
    return json({ ok: true, runs });
  } catch (error) {
    return errorJson(error);
  }
}
