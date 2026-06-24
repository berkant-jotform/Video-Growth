import { NextResponse } from "next/server";
import { createSessionToken, setSessionCookie, verifyPassword } from "@/lib/auth.js";
import { badRequest, errorJson } from "@/lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const password = String(body.password || "");
    const actorName = String(body.actorName || "").trim();
    if (!actorName) throw badRequest("Enter your name or initials.");
    if (!verifyPassword(password)) {
      return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
    }
    const token = createSessionToken({ actorName });
    const response = NextResponse.json({ ok: true, actorName });
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    return errorJson(error);
  }
}
