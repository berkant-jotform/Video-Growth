import { requireSession } from "@/lib/auth.js";
import { errorJson, json } from "@/lib/http.js";
import { getConnectorStatus, lastScanRun, lastSuccessfulScanRun, listDiagnosticLogs } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit") || "100";
    const category = url.searchParams.get("category") || "";
    const [logs, lastScan, lastSuccessfulScan, connectorStatus] = await Promise.all([
      listDiagnosticLogs({ limit, category }),
      lastScanRun(),
      lastSuccessfulScanRun(),
      getConnectorStatus()
    ]);
    return json({
      ok: true,
      logs,
      lastScan,
      lastSuccessfulScan,
      connectorStatus: connectorStatus.map((item) => ({
        connectorId: item.connectorId,
        actorName: item.actorName,
        channels: item.channels,
        version: item.version,
        status: item.status,
        active: item.active,
        lastSeenAt: item.lastSeenAt,
        latestScan: item.payload?.lastStudioScan || null,
        extensionDiagnostics: item.payload?.diagnosticLog || []
      }))
    });
  } catch (error) {
    return errorJson(error);
  }
}
