import { requireConnector } from "@/lib/connector-auth.js";
import { json, errorJson } from "@/lib/http.js";
import { parseConnectorChannels } from "@/lib/finish-events.mjs";
import { recordConnectorHeartbeat, recordDiagnosticLog } from "@/lib/repository.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireConnector(request);
    const body = await request.json();
    const lastStudioScan = sanitizeLastStudioScan(body.lastStudioScan);
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
        openYoutubeTabs: Number(body.openYoutubeTabs || 0),
        notificationWatcherOpen: Boolean(body.notificationWatcherOpen),
        pendingQueue: sanitizePendingQueue(body.pendingQueue),
        pendingFlush: sanitizePendingFlush(body.pendingFlush),
        selfTest: sanitizeSelfTest(body.selfTest),
        userAgent: body.userAgent || "",
        observedAt: body.observedAt || new Date().toISOString(),
        lastStudioScan,
        diagnosticLog: sanitizeExtensionDiagnosticLog(body.diagnosticLog)
      }
    });
    const diagnosis = lastStudioScan?.diagnosis || null;
    const totals = lastStudioScan?.totals || {};
    if (diagnosis?.severity && diagnosis.severity !== "ok") {
      await recordDiagnosticLog({
        category: "extension_scan",
        severity: diagnosis.severity === "warn" ? "warning" : diagnosis.severity,
        message: diagnosis.message || "Extension scan diagnosis",
        actorName: body.actorName || body.reviewerInitials || "",
        context: {
          connectorId: body.connectorId || "",
          version: body.version || "",
          channels: parseConnectorChannels(body.channels || []),
          openStudioTabs: Number(body.openStudioTabs || 0),
          scanCheckedAt: lastStudioScan?.checkedAt || "",
          totals,
          diagnosis,
          diagnosticLog: Array.isArray(body.diagnosticLog) ? body.diagnosticLog.slice(-10) : []
        }
      });
    }
    return json({ ok: true, connectorStatus: status });
  } catch (error) {
    await recordDiagnosticLog({
      category: "extension_heartbeat",
      severity: "error",
      message: "Connector heartbeat failed",
      context: { error: error.message }
    });
    return errorJson(error);
  }
}

function sanitizeStudioTabs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((tab) => ({
    tabTitle: String(tab?.tabTitle || "").slice(0, 160),
    tabUrl: String(tab?.tabUrl || "").slice(0, 300),
    channel: String(tab?.channel || "").slice(0, 120),
    channelId: String(tab?.channelId || "").slice(0, 40),
    notificationButtonFound: Boolean(tab?.notificationButtonFound),
    visibleNotificationContainers: Number(tab?.visibleNotificationContainers || 0),
    bodySnippetCount: Number(tab?.bodySnippetCount || 0),
    rawWindowCount: Number(tab?.rawWindowCount || 0),
    finishHintCount: Number(tab?.finishHintCount || 0),
    ok: tab?.ok !== false,
    error: String(tab?.error || "").slice(0, 240)
  }));
}

function sanitizePendingQueue(value) {
  if (!value || typeof value !== "object") return null;
  return {
    count: Number(value.count || 0),
    oldestQueuedAt: String(value.oldestQueuedAt || "").slice(0, 40),
    newestQueuedAt: String(value.newestQueuedAt || "").slice(0, 40),
    maxAttempts: Number(value.maxAttempts || 0)
  };
}

function sanitizePendingFlush(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok !== false,
    flushed: Number(value.flushed || 0),
    remaining: Number(value.remaining || 0),
    duplicate: Number(value.duplicate || 0),
    error: String(value.error || "").slice(0, 240)
  };
}

function sanitizeSelfTest(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok !== false,
    issues: Array.isArray(value.issues) ? value.issues.map(String).slice(0, 12) : [],
    checkedAt: String(value.checkedAt || "").slice(0, 40)
  };
}

function sanitizeExtensionDiagnosticLog(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((item) => ({
    at: String(item?.at || "").slice(0, 40),
    category: String(item?.category || "").slice(0, 60),
    severity: String(item?.severity || "info").slice(0, 20),
    message: String(item?.message || "").slice(0, 240),
    context: sanitizePlainContext(item?.context || {})
  }));
}

function sanitizePlainContext(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizePlainContext);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).slice(0, 30).map(([key, item]) => {
      if (/token|password|secret|key|authorization|credential/i.test(key)) return [key, item ? "[redacted]" : ""];
      if (typeof item === "string") return [key, item.slice(0, 300)];
      return [key, sanitizePlainContext(item)];
    })
  );
}

function sanitizeLastStudioScan(value) {
  if (!value || typeof value !== "object") return null;
  const totals = value.totals && typeof value.totals === "object" ? value.totals : {};
  const sanitizedTotals = {
    tabs: Number(totals.tabs || 0),
    failed: Number(totals.failed || 0),
    received: Number(totals.received || 0),
    matched: Number(totals.matched || 0),
    unmatched: Number(totals.unmatched || 0),
    ignored: Number(totals.ignored || 0),
    youtubeResolved: Number(totals.youtubeResolved || 0),
    queued: Number(totals.queued || 0),
    duplicate: Number(totals.duplicate || 0),
    candidates: Number(totals.candidates || 0)
  };
  return {
    checkedAt: value.checkedAt || new Date().toISOString(),
    totals: sanitizedTotals,
    tabs: Array.isArray(value.tabs)
      ? value.tabs.slice(0, 8).map((tab) => ({
          tabTitle: String(tab.tabTitle || "").slice(0, 160),
          tabUrl: String(tab.tabUrl || "").slice(0, 300),
          ok: tab.ok !== false,
          error: String(tab.error || "").slice(0, 240),
          received: Number(tab.received || 0),
          matched: Number(tab.matched || 0),
          unmatched: Number(tab.unmatched || 0),
          ignored: Number(tab.ignored || 0),
          youtubeResolved: Number(tab.youtubeResolved || 0),
          queued: Number(tab.queued || 0),
          duplicate: Number(tab.duplicate || 0),
          candidates: Number(tab.candidates || 0),
          menuOpened: Boolean(tab.menuOpened),
          channel: String(tab.channel || "").slice(0, 120),
          rawWindowCount: Number(tab.rawWindowCount || 0),
          finishHintCount: Number(tab.finishHintCount || 0),
          debugSample: String(tab.debugSample || "").slice(0, 700),
          previews: Array.isArray(tab.previews)
            ? tab.previews.slice(0, 3).map((preview) => ({
                title: String(preview.title || "").slice(0, 180),
                videoId: String(preview.videoId || "").slice(0, 32),
                text: String(preview.text || "").slice(0, 240)
              }))
            : []
        }))
      : [],
    diagnosis: normalizeScanDiagnosis(value.diagnosis, sanitizedTotals)
  };
}

function normalizeScanDiagnosis(value, totals) {
  if (
    Number(totals.candidates || 0) > 0 &&
    Number(totals.received || 0) === 0 &&
    Number(totals.unmatched || 0) === 0 &&
    Number(totals.matched || 0) === 0 &&
    Number(totals.queued || 0) === 0 &&
    Number(totals.duplicate || 0) >= Number(totals.candidates || 0)
  ) {
    return {
      severity: "ok",
      code: "already_processed",
      message: "The extension saw A/B finish text that was already processed.",
      action: ""
    };
  }
  return sanitizeScanDiagnosis(value);
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
