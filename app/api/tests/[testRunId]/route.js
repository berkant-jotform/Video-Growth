import { requireSession } from "@/lib/auth.js";
import { getTestRun } from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(_request, { params }) {
  try {
    await requireSession();
    const resolved = await params;
    const test = await getTestRun(resolved.testRunId);
    if (!test) return json({ ok: false, error: "Test run not found." }, { status: 404 });
    return json({ ok: true, test });
  } catch (error) {
    return errorJson(error);
  }
}
