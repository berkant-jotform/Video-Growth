import { requireSession } from "@/lib/auth.js";
import { downloadHistoryExport } from "@/lib/history-export-service.js";
import { errorJson } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(_request, { params }) {
  try {
    await requireSession();
    const { exportId } = await params;
    const file = await downloadHistoryExport(exportId);
    return new Response(file.stream, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${safeName(file.record.fileName)}"`
      }
    });
  } catch (error) {
    return errorJson(error);
  }
}

function safeName(value) {
  return String(value || "youtube-ab-tests.xlsx")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
}
