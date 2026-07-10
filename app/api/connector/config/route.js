import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { listConnectorActiveRuns, getConnectorStatus, listKnownYouTubeChannels } from "@/lib/repository.js";
import { LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";
import { resolveWatcherTabsFromRuns } from "@/lib/finish-events.mjs";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const config = await requireConnector(request);
    const [runs, knownChannels, connectorStatus] = await Promise.all([
      listConnectorActiveRuns(),
      listKnownYouTubeChannels(),
      getConnectorStatus()
    ]);
    const watcherTabs = resolveWatcherTabsFromRuns(config.connectorWatcherTabs, [...runs, ...knownChannels]);
    return json({
      ok: true,
      channels: config.connectorChannels,
      watcherTabs,
      pollMinutes: 60,
      latestExtensionVersion: LATEST_EXTENSION_VERSION,
      activeTests: runs.map((run) => ({
        testRunId: run.testRunId,
	        videoId: run.videoId,
	        channel: run.channel,
	        youtubeChannelId: run.youtubeChannelId || "",
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
