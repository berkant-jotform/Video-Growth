import { getAppConfig, publicConfig, saveAppConfig } from "@/lib/config.js";
import { errorJson, json } from "@/lib/http.js";
import { requireSession } from "@/lib/auth.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const config = await getAppConfig();
    return json({ ok: true, config: publicConfig(config) });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    await requireSession();
    const body = await request.json();
    const saved = await saveAppConfig(body);
    const config = await getAppConfig();
    return json({ ok: true, saved, config: publicConfig(config) });
  } catch (error) {
    return errorJson(error);
  }
}
