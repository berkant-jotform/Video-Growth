import { cookies } from "next/headers";
import { parseSessionToken } from "./session-token.mjs";
export { createSessionToken, parseSessionToken, hashPassword, passwordConfigured, verifyPassword } from "./session-token.mjs";

export const SESSION_COOKIE = "ytab_session";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

export async function readSession() {
  const store = await cookies();
  return parseSessionToken(store.get(SESSION_COOKIE)?.value || "");
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
