import crypto from "node:crypto";
import { get, put } from "@vercel/blob";
import { getAppConfig } from "@/lib/config.js";
import {
  buildHistoryExport,
  HISTORY_EXPORT_SCHEMA_VERSION,
  normalizeHistoryExportRequest
} from "@/lib/history-export.mjs";
import {
  getHistoryExport,
  listRecentHistoryExports,
  loadHistoryExportSource,
  saveHistoryExport,
  upsertVideoContexts
} from "@/lib/history-export-repository.js";
import { buildHistoryExportFile } from "@/lib/history-export-workbook.js";
import { fetchYouTubeVideoContexts } from "@/lib/youtube.js";

const VIDEO_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export async function historyExportStatus() {
  const config = await getAppConfig();
  return {
    enabled: Boolean(config.historyExportsEnabled),
    blobConfigured: Boolean(config.blobReadWriteToken),
    schemaVersion: HISTORY_EXPORT_SCHEMA_VERSION
  };
}

export async function previewHistoryExport({ request, actorName }) {
  const config = await requireHistoryExports();
  const source = await loadHistoryExportSource();
  const exportData = buildHistoryExport({
    source,
    request,
    actorName
  });
  appendContextWarning(exportData, config);
  return exportData.preview;
}

export async function generateHistoryExport({ request, actorName }) {
  const config = await requireHistoryExports();
  const normalized = normalizeHistoryExportRequest(request);
  let source = await loadHistoryExportSource();
  let exportData = buildHistoryExport({
    source,
    request: normalized,
    actorName
  });
  if (exportData.preview.blocking) {
    const error = new Error(
      exportData.preview.warnings.find((item) => item.level === "blocking")?.message ||
      "Export is blocked."
    );
    error.status = 409;
    throw error;
  }

  if (config.youtubeApiKey) {
    const contextByVideo = new Map(
      source.videoContexts.map((item) => [item.videoId, item])
    );
    const refreshIds = Array.from(
      new Set(exportData.datasets.tests.map((test) => test.video_id).filter(Boolean))
    ).filter((videoId) => contextNeedsRefresh(contextByVideo.get(videoId)));
    if (refreshIds.length) {
      try {
        const contexts = await fetchYouTubeVideoContexts(refreshIds, config.youtubeApiKey);
        await upsertVideoContexts(contexts);
        const updated = new Map(source.videoContexts.map((item) => [item.videoId, item]));
        for (const context of contexts) updated.set(context.videoId, context);
        source = { ...source, videoContexts: Array.from(updated.values()) };
        exportData = buildHistoryExport({
          source,
          request: normalized,
          actorName,
          generatedAtUtc: exportData.identity.generatedAtUtc
        });
      } catch {
        exportData.preview.warnings.push({
          level: "degrading",
          message:
            "Current YouTube context could not be refreshed. Cached context remains in the export.",
          action: "refresh_sources"
        });
      }
    }
  }
  appendContextWarning(exportData, config);

  const file = await buildHistoryExportFile(exportData);
  const exportId = crypto.randomUUID();
  let blobUrl = "";
  let blobPathname = "";
  if (config.blobReadWriteToken) {
    const blob = await put(
      `history-exports/${exportId}/${file.fileName}`,
      file.buffer,
      {
        access: "private",
        addRandomSuffix: false,
        contentType: file.contentType,
        token: config.blobReadWriteToken
      }
    );
    blobUrl = blob.url;
    blobPathname = blob.pathname;
  }
  await saveHistoryExport({
    exportId,
    actorName,
    schemaVersion: HISTORY_EXPORT_SCHEMA_VERSION,
    requestHash: exportData.identity.requestHash,
    request: normalized,
    counts: {
      logicalTests: exportData.datasets.tests.length,
      sourceRecords: exportData.datasets.sourceRecords.length,
      variants: exportData.datasets.variants.length,
      actions: exportData.datasets.actions.length,
      finishSignals: exportData.datasets.finishSignals.length,
      resultEvidence: exportData.coverage.wider.find(
        (item) => item.key === "result_evidence"
      )?.includedN || 0,
      sharesPresent: exportData.coverage.wider.find(
        (item) => item.key === "shares_present"
      )?.includedN || 0,
      strictShares: exportData.coverage.wider.find(
        (item) => item.key === "strict_shares"
      )?.includedN || 0
    },
    fileName: file.fileName,
    contentType: file.contentType,
    fileSize: file.buffer.length,
    fileChecksum: file.checksum,
    blobUrl,
    blobPathname
  });
  return {
    exportId,
    ...file,
    preview: exportData.preview,
    stored: Boolean(blobUrl || blobPathname)
  };
}

export async function recentHistoryExports() {
  await requireHistoryExports();
  return listRecentHistoryExports(5);
}

export async function downloadHistoryExport(exportId) {
  const config = await requireHistoryExports();
  const record = await getHistoryExport(exportId);
  if (!record) {
    const error = new Error("Export not found.");
    error.status = 404;
    throw error;
  }
  if (!record.blobUrl && !record.blobPathname) {
    const error = new Error("This export was not stored. Re-run it with the same filters.");
    error.status = 410;
    throw error;
  }
  const result = await get(record.blobUrl || record.blobPathname, {
    access: "private",
    useCache: false,
    token: config.blobReadWriteToken
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    const error = new Error("Stored export is unavailable. Re-run it with the same filters.");
    error.status = 404;
    throw error;
  }
  return {
    record,
    stream: result.stream,
    contentType: result.blob.contentType || record.contentType
  };
}

async function requireHistoryExports() {
  const config = await getAppConfig();
  if (!config.historyExportsEnabled) {
    const error = new Error("History exports are not enabled.");
    error.status = 404;
    throw error;
  }
  return config;
}

function contextNeedsRefresh(context) {
  if (!context?.contextFetchedAt) return true;
  const fetchedAt = new Date(context.contextFetchedAt).valueOf();
  return Number.isNaN(fetchedAt) || Date.now() - fetchedAt > VIDEO_CONTEXT_TTL_MS;
}

function appendContextWarning(exportData, config) {
  const videoIds = new Set(
    exportData.datasets.tests.map((test) => test.video_id).filter(Boolean)
  );
  const contextIds = new Set(
    exportData.datasets.videoContext.map((item) => item.video_id)
  );
  const missing = Array.from(videoIds).filter((videoId) => !contextIds.has(videoId)).length;
  if (!missing) return;
  exportData.preview.warnings.push({
    level: "degrading",
    message: config.youtubeApiKey
      ? `${missing} videos have no current YouTube context.`
      : `${missing} videos have no current YouTube context because the API key is unavailable.`,
    action: "refresh_sources"
  });
}
