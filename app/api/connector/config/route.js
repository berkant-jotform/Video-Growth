import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { listConnectorActiveRuns, getConnectorStatus } from "@/lib/repository.js";

export const runtime = "nodejs";
const LATEST_EXTENSION_VERSION = "0.1.11";

export async function GET(request) {
  try {
    const config = await requireConnector(request);
    const [runs, connectorStatus] = await Promise.all([
      listConnectorActiveRuns(),
      getConnectorStatus()
    ]);
    return json({
      ok: true,
      channels: config.connectorChannels,
      watcherTabs: config.connectorWatcherTabs,
      pollMinutes: 60,
      latestExtensionVersion: LATEST_EXTENSION_VERSION,
      activeTests: runs.map((run) => ({
        testRunId: run.testRunId,
        videoId: run.videoId,
        channel: run.channel,
        testType: run.testType,
        videoTitle: run.videoTitle || run.currentYoutubeTitle,
        studioUrl: run.studioUrl,
        options: run.options,
        startDate: run.startDate,
        source: {
          sheetName: run.sheetName,
          rowNumber: run.rowNumber
        }
      })),
      connectorStatus
    });
  } catch (error) {
    return errorJson(error);
  }
}
