import { requireSession } from "@/lib/auth.js";
import { buildDigest } from "@/lib/notifications.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    await requireSession();
    const digest = await buildDigest("browser");
    return json({
      ok: true,
      browserNotification: {
        title: digest.subject,
        body: `${digest.summary.total} test items need attention.`
      },
      digest
    });
  } catch (error) {
    return errorJson(error);
  }
}
