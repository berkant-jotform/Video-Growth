import crypto from "node:crypto";
import { getAppConfig } from "@/lib/config.js";

export async function requireConnector(request) {
  const config = await getAppConfig();
  if (!config.connectorToken) {
    const error = new Error("CONNECTOR_TOKEN is not configured in Settings.");
    error.status = 503;
    throw error;
  }

  const provided =
    bearerToken(request.headers.get("authorization")) ||
    request.headers.get("x-connector-token") ||
    "";
  if (!safeEqual(provided, config.connectorToken)) {
    const error = new Error("Invalid connector token.");
    error.status = 401;
    throw error;
  }
  return config;
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
