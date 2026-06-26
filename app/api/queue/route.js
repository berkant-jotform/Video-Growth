import { requireSession } from "@/lib/auth.js";
import { applyChannelLogoFallbacks, loadConfiguredChannelLogos } from "@/lib/channel-logos.js";
import { getAppConfig } from "@/lib/config.js";
import {
  getConnectorStatus,
  listQueue,
  listUnmatchedFinishEvents,
  summarizeQueue
} from "@/lib/repository.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    const [runs, unmatchedEvents, connectorStatus, config] = await Promise.all([
      listQueue(),
      listUnmatchedFinishEvents(),
      getConnectorStatus(),
      getAppConfig()
    ]);
    const channelLogos = await loadConfiguredChannelLogos(config);
    const runsWithLogos = applyChannelLogoFallbacks(runs, channelLogos);
    return json({
      ok: true,
      runs: runsWithLogos,
      unmatchedEvents,
      connectorStatus,
      summary: summarizeQueue(runsWithLogos)
    });
  } catch (error) {
    return errorJson(error);
  }
}
