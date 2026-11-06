import crypto from "node:crypto";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
const INITIALS_ONLY_MARKER = "initials-v1";

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
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    actorName: String(actorName || "Reviewer").trim().slice(0, 80) || "Reviewer",
    iat: issuedAt,
    exp: issuedAt + THIRTY_DAYS_SECONDS
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = initialsOnlyMode() ? INITIALS_ONLY_MARKER : sign(encoded);
  return `${encoded}.${signature}`;
}

export function parseSessionToken(token) {
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  try {
    // This mode records a self-declared reviewer label, not a verified identity.
    // Never accept these unsigned cookies when a password or secret is configured.
    if (initialsOnlyMode()) {
      if (signature !== INITIALS_ONLY_MARKER) return null;
    } else if (!safeEqual(signature, sign(encoded))) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof payload?.actorName !== "string" || !payload.actorName.trim() || payload.actorName.length > 80) return null;
    if (!Number.isFinite(payload.iat) || payload.iat <= 0) return null;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number(payload.exp || (Number(payload.iat || 0) + THIRTY_DAYS_SECONDS));
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > payload.iat + THIRTY_DAYS_SECONDS || payload.iat > now) return null;
    return {
      actorName: String(payload.actorName),
      iat: Number(payload.iat || 0)
    };
  } catch {
    return null;
  }
}

function initialsOnlyMode() {
  return !process.env.SESSION_SECRET && !passwordConfigured();
}

function sign(value) {
  const secret = process.env.SESSION_SECRET || process.env.APP_SHARED_PASSWORD_HASH;
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
