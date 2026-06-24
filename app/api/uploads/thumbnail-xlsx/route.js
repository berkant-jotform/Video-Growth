import { requireSession } from "@/lib/auth.js";
import { importThumbnailWorkbook } from "@/lib/uploads.js";
import { listUploads } from "@/lib/repository.js";
import { badRequest, errorJson, json } from "@/lib/http.js";
import { getAppConfig } from "@/lib/config.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    await requireSession();
    const form = await request.formData();
    const file = form.get("file");
    const sourceKind = String(form.get("sourceKind") || "thumbnail");
    if (!file || typeof file.arrayBuffer !== "function") throw badRequest("Upload an XLSX file.");
    const config = await getAppConfig();
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
