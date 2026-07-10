import crypto from "node:crypto";
import { getAppConfig } from "@/lib/config.js";
import { authenticateConnectorDeviceToken } from "@/lib/connector-tokens.js";

export async function requireConnector(request) {
  const config = await getAppConfig();
  const provided =
    bearerToken(request.headers.get("authorization")) ||
    request.headers.get("x-connector-token") ||
    "";
  const legacyMatch = Boolean(config.connectorToken && safeEqual(provided, config.connectorToken));
  const connectorDevice = legacyMatch ? null : await authenticateConnectorDeviceToken(provided);
  if (!legacyMatch && !connectorDevice) {
    const error = new Error("Invalid connector token.");
    error.status = 401;
    throw error;
  }
  return { ...config, connectorDevice };
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
