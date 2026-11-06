import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createSessionToken, parseSessionToken, hashPassword, verifyPassword } from "../lib/session-token.mjs";

function withEnv(values, run) {
  const keys = ["SESSION_SECRET", "APP_SHARED_PASSWORD_HASH", "NODE_ENV"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { run(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function encode(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

test("production initials-only login works without a signing secret or database", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    const token = createSessionToken({ actorName: " BG " });
    assert.match(token, /\.initials-v1$/);
    assert.equal(parseSessionToken(token).actorName, "BG");
    assert.equal(parseSessionToken(createSessionToken({ actorName: "A".repeat(100) })).actorName.length, 80);
  });
});

test("malformed, expired, future-dated, oversized and old known-key cookies are rejected", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    const now = Math.floor(Date.now() / 1000);
    for (const payload of [
      { actorName: "BG", iat: now - 100, exp: now - 1 },
      { actorName: "BG", iat: now + 100, exp: now + 200 },
      { actorName: "BG", iat: now, exp: now + 2592001 },
      { actorName: {}, iat: now, exp: now + 100 },
      { actorName: " ", iat: now, exp: now + 100 },
      { actorName: "A".repeat(81), iat: now, exp: now + 100 },
      { actorName: "BG", iat: "bad", exp: "bad" }
    ]) assert.equal(parseSessionToken(`${encode(payload)}.initials-v1`), null);
    for (const value of ["", "x", "bad.initials-v1", "e30=.initials-v1", `${createSessionToken({ actorName: "BG" })}.extra`]) {
      assert.equal(parseSessionToken(value), null);
    }
    const encoded = encode({ actorName: "BG", iat: now, exp: now + 100 });
    const signature = crypto.createHmac("sha256", "youtube-ab-tests-local-development").update(encoded).digest("base64url");
    assert.equal(parseSessionToken(`${encoded}.${signature}`), null);
  });
});

test("configuring either secret or password rejects unsigned cookies and verifies signatures", () => {
  let unsigned;
  withEnv({ NODE_ENV: "production" }, () => { unsigned = createSessionToken({ actorName: "BG" }); });
  for (const settings of [
    { SESSION_SECRET: "test-only-private-signing-key" },
    { APP_SHARED_PASSWORD_HASH: hashPassword("test-only-password") },
    { SESSION_SECRET: "test-only-private-signing-key", APP_SHARED_PASSWORD_HASH: hashPassword("test-only-password") }
  ]) withEnv({ ...settings, NODE_ENV: "production" }, () => {
    assert.equal(parseSessionToken(unsigned), null);
    const token = createSessionToken({ actorName: "BG" });
    assert.equal(parseSessionToken(token).actorName, "BG");
    const [encoded, signature] = token.split(".");
    const tampered = encode({ ...JSON.parse(Buffer.from(encoded, "base64url")), actorName: "OTHER" });
    assert.equal(parseSessionToken(`${tampered}.${signature}`), null);
    assert.equal(parseSessionToken(`${encoded}.${signature}extra`), null);
    if (settings.APP_SHARED_PASSWORD_HASH) {
      assert.equal(verifyPassword("test-only-password"), true);
      assert.equal(verifyPassword("wrong"), false);
    }
  });
});

test("existing signed cookies and legacy issued-at expiry remain compatible", () => {
  withEnv({ SESSION_SECRET: "test-only-private-signing-key" }, () => {
    const encoded = encode({ actorName: "BG", iat: Math.floor(Date.now() / 1000) });
    const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(encoded).digest("base64url");
    assert.equal(parseSessionToken(`${encoded}.${signature}`).actorName, "BG");
    process.env.SESSION_SECRET = "rotated-test-only-key";
    assert.equal(parseSessionToken(`${encoded}.${signature}`), null);
  });
});
