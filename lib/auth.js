import crypto from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ytab_session";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

export function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
}

export function passwordConfigured() {
  return Boolean(process.env.APP_SHARED_PASSWORD_HASH);
}

export function verifyPassword(password) {
  const expected = process.env.APP_SHARED_PASSWORD_HASH || "";
  if (!expected) return false;
  const actual = hashPassword(password);
  return safeEqual(actual, expected);
}

export function createSessionToken({ actorName }) {
  const payload = {
    actorName: String(actorName || "Reviewer").trim().slice(0, 80) || "Reviewer",
    iat: Math.floor(Date.now() / 1000)
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export async function readSession() {
  const store = await cookies();
  return parseSessionToken(store.get(SESSION_COOKIE)?.value || "");
}

export function parseSessionToken(token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature || !safeEqual(signature, sign(encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload?.actorName) return null;
    return {
      actorName: String(payload.actorName),
      iat: Number(payload.iat || 0)
    };
  } catch {
    return null;
  }
}

export async function requireSession() {
  const session = await readSession();
  if (!session) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }
  return session;
}

export function setSessionCookie(response, token) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS
  });
}

export function clearSessionCookie(response) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

function sign(value) {
  const secret = process.env.SESSION_SECRET || process.env.APP_SHARED_PASSWORD_HASH || "dev-session-secret";
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
