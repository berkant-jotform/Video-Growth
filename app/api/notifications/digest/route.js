import { requireSession } from "@/lib/auth.js";
import { sendEmailDigest, sendSlackDigest } from "@/lib/notifications.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    await requireSession();
    const slack = await sendSlackDigest();
    const smtp = await sendEmailDigest();
    return json({ ok: true, slack, smtp });
  } catch (error) {
    return errorJson(error);
  }
}
