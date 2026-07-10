import { requireSession } from "@/lib/auth.js";
import { getPreviewBlob } from "@/lib/blob.js";
import { getAppConfig } from "@/lib/config.js";
import { errorJson } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireSession();
    const url = new URL(request.url).searchParams.get("url") || "";
    const config = await getAppConfig();
    if (!config.blobReadWriteToken) {
      const error = new Error("Thumbnail storage is not configured.");
      error.status = 503;
      throw error;
    }
    const result = await getPreviewBlob(url, { token: config.blobReadWriteToken });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return new Response(null, { status: result?.statusCode === 304 ? 304 : 404 });
    }
    return new Response(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType || "application/octet-stream",
        "Cache-Control": "private, max-age=3600, stale-while-revalidate=86400",
        ETag: result.blob.etag || "",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return errorJson(error);
  }
}
