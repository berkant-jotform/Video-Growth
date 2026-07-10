import { handleUpload } from "@vercel/blob/client";
import { requireSession } from "@/lib/auth.js";
import { getAppConfig } from "@/lib/config.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.type === "blob.generate-client-token") await requireSession();
    const config = await getAppConfig();
    if (!config.blobReadWriteToken) {
      return json({ ok: false, error: "Vercel Blob is not configured." }, { status: 503 });
    }
    const result = await handleUpload({
      request,
      body,
      token: config.blobReadWriteToken,
      onBeforeGenerateToken: async (pathname) => {
        if (!String(pathname || "").toLowerCase().endsWith(".xlsx")) {
          throw new Error("Only .xlsx workbook snapshots are allowed.");
        }
        return {
          allowedContentTypes: [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/octet-stream"
          ],
          maximumSizeInBytes: 220 * 1024 * 1024,
          addRandomSuffix: true,
          allowOverwrite: false,
          cacheControlMaxAge: 60
        };
      }
    });
    return json(result);
  } catch (error) {
    return errorJson(error);
  }
}
