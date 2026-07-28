import { requireSession } from "@/lib/auth.js";
import { badRequest, errorJson } from "@/lib/http.js";
import { generateHistoryExport } from "@/lib/history-export-service.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => {
      throw badRequest("Export request must be valid JSON.");
    });
    const file = await generateHistoryExport({
      request: body,
      actorName: session.actorName
    });
    return new Response(file.buffer, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": contentDisposition(file.fileName),
        "Content-Length": String(file.buffer.length),
        "X-Export-Id": file.exportId,
        "X-Export-Stored": String(file.stored)
      }
    });
  } catch (error) {
    return errorJson(error);
  }
}

function contentDisposition(fileName) {
  const ascii = String(fileName || "youtube-ab-tests.xlsx")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"`;
}
