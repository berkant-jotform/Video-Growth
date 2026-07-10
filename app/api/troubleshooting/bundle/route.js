import { requireSession } from "@/lib/auth.js";
import { getAppConfig, publicConfig } from "@/lib/config.js";
import { errorJson, json } from "@/lib/http.js";
import {
  getConnectorStatus,
  lastScanRun,
  lastSuccessfulScanRun,
  listDiagnosticLogs,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { APP_VERSION, LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const [config, lastScan, lastSuccessfulScan, connectorStatus, logs, queue, unmatchedEvents] = await Promise.all([
      getAppConfig(),
      lastScanRun(),
      lastSuccessfulScanRun(),
      getConnectorStatus(),
      listDiagnosticLogs({ limit: 120 }),
      listQueue(),
      listUnmatchedFinishEvents()
    ]);
    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      generatedBy: session.actorName || "",
      app: {
        name: "YouTube A/B Tests",
        version: APP_VERSION,
        latestExtensionVersion: LATEST_EXTENSION_VERSION
      },
      config: publicConfig(config),
      scans: {
        lastScan,
        lastSuccessfulScan
      },
      connectorStatus: connectorStatus.map(safeConnectorStatus),
      queue: {
        summary: summarizeQueue(queue),
        samples: queue.slice(0, 80).map(safeRunSample)
      },
      unmatchedSignals: unmatchedEvents.slice(0, 80),
      logs
    });
  } catch (error) {
    return errorJson(error);
  }
}

function safeConnectorStatus(item) {
  return {
    connectorId: item.connectorId,
    actorName: item.actorName,
    channels: item.channels,
    version: item.version,
    status: item.status,
    active: item.active,
    lastSeenAt: item.lastSeenAt,
    payload: item.payload
  };
}

function safeRunSample(run) {
  return {
    testRunId: run.testRunId,
    videoId: run.videoId,
    channel: run.channel,
    youtubeChannelId: run.youtubeChannelId,
    testType: run.testType,
    title: run.videoTitle || run.currentYoutubeTitle,
    queueStatus: run.queueStatus,
    status: run.status,
    unregistered: Boolean(run.unregistered),
    detectedOutcome: run.detectedOutcome,
    finishEventSource: run.finishEventSource,
    finishEventOutcome: run.finishEventOutcome,
    finishEventAt: run.finishEventAt,
    finishEventNotificationAge: run.finishEventNotificationAge,
    matchedConfidence: run.matchedConfidence,
    sheetName: run.sheetName,
    rowNumber: run.rowNumber,
    signalResolution: run.signalResolution || null
  };
}
