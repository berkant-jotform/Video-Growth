import { runScan } from "@/lib/scanner.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const secret = process.env.CRON_SECRET || "";
    if (secret) {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${secret}`) {
        return json({ ok: false, error: "Unauthorized cron request." }, { status: 401 });
      }
    }
    const result = await runScan({ actorName: "vercel-cron" });
    return json(result);
  } catch (error) {
    return errorJson(error);
  }
}
