import { requireConnector } from "@/lib/connector-auth.js";
import { getAppConfig } from "@/lib/config.js";
import { json, errorJson } from "@/lib/http.js";
import { LATEST_EXTENSION_VERSION } from "@/lib/app-version.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    await requireConnector(request);
    const config = await getAppConfig();
    return json({
      ok: true,
      latestExtensionVersion: LATEST_EXTENSION_VERSION,
      runtimeConfig: config.extensionRuntimeConfig
    });
  } catch (error) {
    return errorJson(error);
  }
}
