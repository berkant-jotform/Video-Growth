import { requireSession } from "@/lib/auth.js";
import {
  createConnectorDeviceToken,
  listConnectorDeviceTokens,
  revokeConnectorDeviceToken
} from "@/lib/connector-tokens.js";
import { badRequest, errorJson, json } from "@/lib/http.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireSession();
    return json({ ok: true, tokens: await listConnectorDeviceTokens() });
  } catch (error) {
    return errorJson(error);
  }
}

export async function POST(request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const label = String(body.label || "").trim();
    if (!label) throw badRequest("Enter a browser or teammate name for this extension.");
    const created = await createConnectorDeviceToken({ label, actorName: session.actorName });
    return json({ ok: true, token: created });
  } catch (error) {
    return errorJson(error);
  }
}

export async function DELETE(request) {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({}));
    const tokenId = String(body.tokenId || "").trim();
    if (!tokenId) throw badRequest("Missing extension token ID.");
    const revoked = await revokeConnectorDeviceToken(tokenId);
    if (!revoked) return json({ ok: false, error: "Extension token was not found or is already revoked." }, { status: 404 });
    return json({ ok: true });
  } catch (error) {
    return errorJson(error);
  }
}
