import { runScan } from "@/lib/scanner.js";
import { sendEmailDigest, sendSlackDigest } from "@/lib/notifications.js";
import { errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const secret = process.env.CRON_SECRET || "";
    if (!secret) {
      return json({ ok: false, error: "CRON_SECRET is not configured." }, { status: 503 });
    }
    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return json({ ok: false, error: "Unauthorized cron request." }, { status: 401 });
    }
    const scan = await runScan({ actorName: "vercel-cron" });
    const [slack, email] = await Promise.allSettled([sendSlackDigest(), sendEmailDigest()]);
    return json({
      ...scan,
      notifications: {
        slack: settledResult(slack),
        email: settledResult(email)
      }
    });
  } catch (error) {
    return errorJson(error);
  }
}

function settledResult(result) {
  if (result.status === "fulfilled") return result.value;
  return { ok: false, error: result.reason?.message || "Notification delivery failed." };
}
