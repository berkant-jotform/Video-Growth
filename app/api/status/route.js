import { databaseConfigured } from "@/lib/db.js";
import { lastScanRun } from "@/lib/repository.js";
import { readSession } from "@/lib/auth.js";
import { json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  const session = await readSession();
  let lastScan = null;
  let databaseOk = false;
  let databaseError = "";
  if (databaseConfigured()) {
    try {
      lastScan = await lastScanRun();
      databaseOk = true;
    } catch (error) {
      databaseError = error.message;
    }
  }
  return json({
    ok: true,
    app: "YouTube A/B Tests",
    version: "2.0.0",
    authenticated: Boolean(session),
    actorName: session?.actorName || "",
    configured: {
      database: databaseOk,
      databaseUrlPresent: databaseConfigured(),
      sharedPassword: Boolean(process.env.APP_SHARED_PASSWORD_HASH)
    },
    databaseError,
    lastScan
  });
}
