import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { listConnectorActiveRuns, getConnectorStatus, listKnownYouTubeChannels } from "@/lib/repository.js";
import { LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";
import { resolveWatcherTabsFromRuns } from "@/lib/finish-events.mjs";
import crypto from "node:crypto";

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
    const configRevision = crypto.createHash("sha256").update(JSON.stringify({
      channels: config.connectorChannels,
      watcherTabs,
      runtime: config.extensionRuntimeConfig
    })).digest("hex").slice(0, 16);
    return json({
      ok: true,
      channels: config.connectorChannels,
      watcherTabs,
      configRevision,
      pollMinutes: config.extensionRuntimeConfig?.passiveScanMinutes || 60,
      commandPollMinutes: config.extensionRuntimeConfig?.commandPollMinutes || 1,
      startupCatchupMinutes: config.extensionRuntimeConfig?.startupCatchupMinutes || 20,
      latestExtensionVersion: LATEST_EXTENSION_VERSION,
      capabilitiesRequired: {
        durableJobs: true,
        acknowledgedOutbox: true,
        ownedWatchers: true,
        exactChannelIdentity: true,
        remoteProfiles: true,
        remoteWatcherSync: true,
        verifiedBellCoverage: true,
        retestAwareDedupe: true
      },
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
