import { getAppConfig, publicConfig, saveAppConfig } from "@/lib/config.js";
import { errorJson, json } from "@/lib/http.js";
import { requireSession } from "@/lib/auth.js";
import { getConnectorStatus, listKnownYouTubeChannels } from "@/lib/repository.js";
import { databaseConfigured } from "@/lib/db.js";
import { hasActiveConnectorDeviceTokens } from "@/lib/connector-tokens.js";
import { resolveWatcherTabsFromRuns } from "@/lib/finish-events.mjs";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const [config, connectorStatus, deviceTokensConfigured, knownChannels] = await Promise.all([
      getAppConfig(),
      databaseConfigured() ? getConnectorStatus() : [],
      databaseConfigured() ? hasActiveConnectorDeviceTokens() : false,
      databaseConfigured() ? listKnownYouTubeChannels() : []
    ]);
    return json({ ok: true, config: responseConfig(config, connectorStatus, deviceTokensConfigured, knownChannels) });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    await requireSession();
    const body = await request.json();
    const saved = await saveAppConfig(body);
    const [config, connectorStatus, deviceTokensConfigured, knownChannels] = await Promise.all([
      getAppConfig(),
      databaseConfigured() ? getConnectorStatus() : [],
      databaseConfigured() ? hasActiveConnectorDeviceTokens() : false,
      databaseConfigured() ? listKnownYouTubeChannels() : []
    ]);
    return json({ ok: true, saved, config: responseConfig(config, connectorStatus, deviceTokensConfigured, knownChannels) });
  } catch (error) {
    return errorJson(error);
  }
}

function responseConfig(config, connectorStatus, deviceTokensConfigured, knownChannels) {
  const result = publicConfig(config);
  result.configured.connectorToken = Boolean(result.configured.connectorToken || deviceTokensConfigured);
  result.resolvedWatcherTabs = resolveWatcherTabsFromRuns(config.connectorWatcherTabs, knownChannels || []);
  return { ...result, connectorStatus };
}
