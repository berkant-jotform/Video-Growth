import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { parseConnectorChannels } from "@/lib/finish-events.mjs";
import { recordConnectorHeartbeat } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireConnector(request);
    const body = await request.json();
    const status = await recordConnectorHeartbeat({
      connectorId: body.connectorId || "",
      actorName: body.actorName || body.reviewerInitials || "",
      channels: parseConnectorChannels(body.channels || []),
      version: body.version || "",
      status: body.status || "online",
      payload: {
        location: body.location || "",
        openStudioTabs: Number(body.openStudioTabs || 0),
        studioTabUrls: Array.isArray(body.studioTabUrls)
          ? body.studioTabUrls.map(String).filter(Boolean).slice(0, 20)
          : [],
        studioTabs: sanitizeStudioTabs(body.studioTabs),
        userAgent: body.userAgent || "",
        observedAt: body.observedAt || new Date().toISOString(),
        lastStudioScan: sanitizeLastStudioScan(body.lastStudioScan)
      }
    });
    return json({ ok: true, connectorStatus: status });
  } catch (error) {
    return errorJson(error);
  }
}

function sanitizeStudioTabs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((tab) => ({
    tabTitle: String(tab?.tabTitle || "").slice(0, 160),
    tabUrl: String(tab?.tabUrl || "").slice(0, 300),
    channel: String(tab?.channel || "").slice(0, 120),
    notificationButtonFound: Boolean(tab?.notificationButtonFound),
    visibleNotificationContainers: Number(tab?.visibleNotificationContainers || 0),
    bodySnippetCount: Number(tab?.bodySnippetCount || 0),
    ok: tab?.ok !== false,
    error: String(tab?.error || "").slice(0, 240)
  }));
}

function sanitizeLastStudioScan(value) {
  if (!value || typeof value !== "object") return null;
  const totals = value.totals && typeof value.totals === "object" ? value.totals : {};
  return {
    checkedAt: value.checkedAt || new Date().toISOString(),
    totals: {
      tabs: Number(totals.tabs || 0),
      failed: Number(totals.failed || 0),
      received: Number(totals.received || 0),
      matched: Number(totals.matched || 0),
      unmatched: Number(totals.unmatched || 0),
      ignored: Number(totals.ignored || 0),
      candidates: Number(totals.candidates || 0)
    },
    tabs: Array.isArray(value.tabs)
      ? value.tabs.slice(0, 8).map((tab) => ({
          tabTitle: String(tab.tabTitle || "").slice(0, 160),
          tabUrl: String(tab.tabUrl || "").slice(0, 300),
          ok: tab.ok !== false,
          error: String(tab.error || "").slice(0, 240),
          received: Number(tab.received || 0),
          matched: Number(tab.matched || 0),
          unmatched: Number(tab.unmatched || 0),
          candidates: Number(tab.candidates || 0),
          menuOpened: Boolean(tab.menuOpened),
          channel: String(tab.channel || "").slice(0, 120),
          previews: Array.isArray(tab.previews)
            ? tab.previews.slice(0, 3).map((preview) => ({
                title: String(preview.title || "").slice(0, 180),
                videoId: String(preview.videoId || "").slice(0, 32),
                text: String(preview.text || "").slice(0, 240)
              }))
            : []
        }))
      : [],
    diagnosis: sanitizeScanDiagnosis(value.diagnosis)
  };
}

function sanitizeScanDiagnosis(value) {
  if (!value || typeof value !== "object") return null;
  return {
    severity: String(value.severity || "info").slice(0, 20),
    code: String(value.code || "").slice(0, 80),
    message: String(value.message || "").slice(0, 240),
    action: String(value.action || "").slice(0, 240)
  };
}
