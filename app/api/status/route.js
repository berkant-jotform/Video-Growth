import { databaseConfigured } from "@/lib/db.js";
import { getConnectorStatus, lastScanRun, lastSuccessfulScanRun } from "@/lib/repository.js";
import { getAppConfig } from "@/lib/config.js";
import { readSession } from "@/lib/auth.js";
import { json } from "@/lib/http.js";
import { APP_VERSION, LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";
import { hasActiveConnectorDeviceTokens } from "@/lib/connector-tokens.js";

export const runtime = "nodejs";

export async function GET() {
  const session = await readSession();
  if (!session) {
    return json(
      {
        ok: true,
        app: "YouTube A/B Tests",
        version: APP_VERSION,
        authenticated: false,
        actorName: "",
        configured: {
          database: databaseConfigured(),
          databaseUrlPresent: databaseConfigured(),
          sharedPassword: Boolean(process.env.APP_SHARED_PASSWORD_HASH),
          connector: false
        },
        databaseError: "",
        lastScan: null,
        lastSuccessfulScan: null,
        connector: {
          configured: false,
          channels: [],
          watcherTabs: [],
          latestExtensionVersion: LATEST_EXTENSION_VERSION
        },
        connectorStatus: []
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
  let lastScan = null;
  let lastSuccessfulScan = null;
  let connectorStatus = [];
  let connector = {
    configured: false,
    channels: [],
    watcherTabs: []
  };
  let connectorConfigured = false;
  let databaseOk = false;
  let databaseError = "";
  if (databaseConfigured()) {
    try {
      const [scan, successfulScan, status, config, deviceTokensConfigured] = await Promise.all([
        lastScanRun(),
        lastSuccessfulScanRun(),
        getConnectorStatus(),
        getAppConfig(),
        hasActiveConnectorDeviceTokens()
      ]);
      lastScan = scan;
      lastSuccessfulScan = successfulScan;
      connectorStatus = status;
      connectorConfigured = Boolean(config.connectorToken || deviceTokensConfigured);
      connector = {
        configured: connectorConfigured,
        channels: config.connectorChannels,
        watcherTabs: config.connectorWatcherTabs,
        latestExtensionVersion: LATEST_EXTENSION_VERSION
      };
      databaseOk = true;
    } catch (error) {
      databaseError = error.message;
    }
  }
  return json({
    ok: true,
    app: "YouTube A/B Tests",
    version: APP_VERSION,
    authenticated: Boolean(session),
    actorName: session?.actorName || "",
    configured: {
      database: databaseOk,
      databaseUrlPresent: databaseConfigured(),
      sharedPassword: Boolean(process.env.APP_SHARED_PASSWORD_HASH),
      connector: connectorConfigured
    },
    databaseError,
    lastScan,
    lastSuccessfulScan,
    connector,
    connectorStatus
  }, { headers: { "Cache-Control": "private, no-store" } });
}
