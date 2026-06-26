import { databaseConfigured } from "@/lib/db.js";
import { getConnectorStatus, lastScanRun } from "@/lib/repository.js";
import { getAppConfig } from "@/lib/config.js";
import { readSession } from "@/lib/auth.js";
import { json } from "@/lib/http.js";

export const runtime = "nodejs";
const LATEST_EXTENSION_VERSION = "0.1.4";

export async function GET() {
  const session = await readSession();
  let lastScan = null;
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
      const [scan, status, config] = await Promise.all([
        lastScanRun(),
        getConnectorStatus(),
        getAppConfig()
      ]);
      lastScan = scan;
      connectorStatus = status;
      connectorConfigured = Boolean(config.connectorToken);
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
    version: "3.0.0",
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
    connector,
    connectorStatus
  });
}
