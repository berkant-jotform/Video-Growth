import { requireSession } from "@/lib/auth.js";
import { createConnectorPairing, pairingStatus } from "@/lib/connector-control.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireSession();
    const pairingId = new URL(request.url).searchParams.get("pairingId") || "";
    if (!pairingId) throw badRequest("Missing pairing ID.");
    const pairing = await pairingStatus(pairingId);
    return pairing
      ? json({ ok: true, pairing }, { headers: { "Cache-Control": "private, no-store" } })
      : json({ ok: false, error: "Pairing request was not found." }, { status: 404 });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const label = String(body.label || "").trim();
    if (!label) throw badRequest("Name this browser, for example BG work Chrome.");
    const pairing = await createConnectorPairing({ label, actorName: session.actorName });
    return json({ ok: true, pairing });
  } catch (error) {
    return errorJson(error);
  }
}
