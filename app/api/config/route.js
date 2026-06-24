import { getAppConfig, publicConfig, saveAppConfig } from "@/lib/config.js";
import { errorJson, json } from "@/lib/http.js";
import { requireSession } from "@/lib/auth.js";
import { getConnectorStatus } from "@/lib/repository.js";
import { databaseConfigured } from "@/lib/db.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const [config, connectorStatus] = await Promise.all([
      getAppConfig(),
      databaseConfigured() ? getConnectorStatus() : []
    ]);
    return json({ ok: true, config: { ...publicConfig(config), connectorStatus } });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    await requireSession();
    const body = await request.json();
    const saved = await saveAppConfig(body);
    const [config, connectorStatus] = await Promise.all([
      getAppConfig(),
      databaseConfigured() ? getConnectorStatus() : []
    ]);
    return json({ ok: true, saved, config: { ...publicConfig(config), connectorStatus } });
  } catch (error) {
    return errorJson(error);
  }
}
