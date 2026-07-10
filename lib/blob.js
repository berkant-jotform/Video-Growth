import { get, put } from "@vercel/blob";

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

export async function putPreviewBlob(pathname, body, { token, contentType }) {
  const common = {
    token,
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60 * 60 * 24 * 30
  };
  try {
    const blob = await put(pathname, body, { ...common, access: "public" });
    return { ...blob, access: "public" };
  } catch (error) {
    if (!isBlobAccessMismatch(error)) throw error;
    const blob = await put(pathname, body, { ...common, access: "private" });
    return { ...blob, access: "private" };
  }
}

export async function getPreviewBlob(url, { token }) {
  assertAllowedBlobUrl(url);
  try {
    const result = await get(url, { access: "public", token });
    if (result) return result;
  } catch (error) {
    if (!isBlobAccessMismatch(error)) throw error;
  }
  return get(url, { access: "private", token });
}

export function previewDisplayUrl(url) {
  const value = String(url || "").trim();
  if (!value || !isVercelBlobUrl(value)) return value;
  return `/api/thumbnail-previews/file?url=${encodeURIComponent(value)}`;
}

export function isVercelBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function assertAllowedBlobUrl(value) {
  if (!isVercelBlobUrl(value)) {
    const error = new Error("Unsupported thumbnail preview URL.");
    error.status = 400;
    throw error;
  }
}

function isBlobAccessMismatch(error) {
  const text = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("access") || text.includes("private") || text.includes("public");
}
