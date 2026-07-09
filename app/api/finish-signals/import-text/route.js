import { requireSession } from "@/lib/auth.js";
import { getAppConfig } from "@/lib/config.js";
import { badRequest, errorJson, json } from "@/lib/http.js";
import { expandConnectorEventInputs } from "@/lib/finish-events.mjs";
import { recordConnectorEvents, recordDiagnosticLog } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const text = String(body.text || "").trim();
    if (text.length < 20) throw badRequest("Paste the visible YouTube notification text first.");

    const channelScope = Array.isArray(body.channelScope)
      ? body.channelScope.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const channel = channelScope.length === 1 ? channelScope[0] : String(body.channel || "").trim();
    const rawEvents = [
      {
        source: "manual_bell_text",
        rawText: text,
        channel,
        observedAt: new Date().toISOString()
      }
    ];
    const events = expandConnectorEventInputs(rawEvents);
    if (!events.length) throw badRequest("No A/B finish notification lines were found in the pasted text.");

    const config = await getAppConfig();
    const results = await recordConnectorEvents({
      events,
      actorName: session.actorName,
      connectorId: "manual_bell_text",
      source: "manual_bell_text",
      youtubeApiKey: config.youtubeApiKey,
      channelScope,
      testTypeScope: body.testTypeScope || "all"
    });

    const matched = results.filter((item) => item.processingStatus === "matched").length;
    const unmatched = results.filter((item) => item.processingStatus === "unmatched").length;
    const ignored = results.filter((item) => item.processingStatus === "ignored").length;
    const youtubeResolved = results.filter((item) => item.youtubeResolved).length;

    await recordDiagnosticLog({
      category: "manual_bell_text_import",
      severity: matched ? "info" : "warning",
      message: "Manual bell notification text imported",
      actorName: session.actorName,
      context: {
        channelScope,
        testTypeScope: body.testTypeScope || "all",
        textLength: text.length,
        expanded: events.length,
        matched,
        unmatched,
        ignored,
        youtubeResolved,
        previews: events.slice(0, 8).map((event) => ({
          videoTitle: event.videoTitle || "",
          rawText: String(event.rawText || "").slice(0, 240)
        }))
      }
    });

    return json({
      ok: true,
      received: events.length,
      matched,
      unmatched,
      ignored,
      youtubeResolved,
      results
    });
  } catch (error) {
    await recordDiagnosticLog({
      category: "manual_bell_text_import",
      severity: "error",
      message: "Manual bell notification text import failed",
      context: { error: error.message }
    });
    return errorJson(error);
  }
}
