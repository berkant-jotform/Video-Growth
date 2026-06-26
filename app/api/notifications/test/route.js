import { requireSession } from "@/lib/auth.js";
import { buildDigest } from "@/lib/notifications.js";
import { listNotificationProfiles } from "@/lib/notification-profiles.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({}));
    const profiles = body.profileId ? await listNotificationProfiles() : [];
    const profile = profiles.find((item) => item.profileId === body.profileId) || null;
    const digest = profile ? await buildDigest("browser", profile.rules, profile) : await buildDigest("browser");
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
