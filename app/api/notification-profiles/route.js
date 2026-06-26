import { requireSession } from "@/lib/auth.js";
import { errorJson, json } from "@/lib/http.js";
import { listNotificationProfiles, saveNotificationProfiles } from "@/lib/notification-profiles.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const profiles = await listNotificationProfiles();
    return json({ ok: true, profiles });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    await requireSession();
    const body = await request.json();
    const profiles = await saveNotificationProfiles(body.profiles || []);
    return json({ ok: true, profiles });
  } catch (error) {
    return errorJson(error);
  }
}
