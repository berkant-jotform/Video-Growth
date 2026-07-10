import { requireSession } from "@/lib/auth.js";
import { del } from "@vercel/blob";
import { importThumbnailWorkbook, importThumbnailWorkbookBuffer } from "@/lib/uploads.js";
import { getPreviewBlob } from "@/lib/blob.js";
import { listUploads } from "@/lib/repository.js";
import { badRequest, errorJson, json } from "@/lib/http.js";
import { getAppConfig } from "@/lib/config.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireSession();
    const config = await getAppConfig();
    if ((request.headers.get("content-type") || "").includes("application/json")) {
      const body = await request.json();
      const blobUrl = String(body.blobUrl || "").trim();
      if (!blobUrl) throw badRequest("Missing uploaded workbook URL.");
      try {
        const stored = await getPreviewBlob(blobUrl, { token: config.blobReadWriteToken });
        if (!stored || stored.statusCode !== 200 || !stored.stream) throw badRequest("Uploaded workbook could not be read.");
        const buffer = Buffer.from(await new Response(stored.stream).arrayBuffer());
        const result = await importThumbnailWorkbookBuffer({
          buffer,
          filename: String(body.filename || stored.blob.pathname || "thumbnail-snapshot.xlsx"),
          sourceKind: String(body.sourceKind || "thumbnail"),
          blobToken: config.blobReadWriteToken
        });
        return json({ ok: true, ...result });
      } finally {
        await del(blobUrl, { token: config.blobReadWriteToken }).catch(() => null);
      }
    }
    const form = await request.formData();
    const file = form.get("file");
    const sourceKind = String(form.get("sourceKind") || "thumbnail");
    if (!file || typeof file.arrayBuffer !== "function") throw badRequest("Upload an XLSX file.");
    if (!String(file.name || "").toLowerCase().endsWith(".xlsx")) throw badRequest("Upload an .xlsx workbook snapshot.");
    if (Number(file.size || 0) > 220 * 1024 * 1024) {
      const error = new Error("The XLSX snapshot is larger than 220 MB. Export only the active thumbnail tabs and try again.");
      error.status = 413;
      throw error;
    }
    const result = await importThumbnailWorkbook({
      file,
      sourceKind,
      blobToken: config.blobReadWriteToken
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return errorJson(error);
  }
}

export async function GET() {
  try {
    await requireSession();
    const uploads = await listUploads();
    return json({ ok: true, uploads });
  } catch (error) {
    return errorJson(error);
  }
}
