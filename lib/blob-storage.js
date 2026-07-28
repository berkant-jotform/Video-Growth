import { get, put } from "@vercel/blob";

const INVALID_TOKEN_VALUES = new Set(["", "[SENSITIVE]", "undefined", "null"]);

export function blobTokenCandidates(config = {}) {
  const candidates = [
    ["BLOB_READ_WRITE_TOKEN", config.blobReadWriteToken],
    ["BLOBP_READ_WRITE_TOKEN", process.env.BLOBP_READ_WRITE_TOKEN]
  ];
  const seen = new Set();
  return candidates
    .map(([key, token]) => ({ key, token: String(token || "").trim() }))
    .filter(({ token }) => {
      if (INVALID_TOKEN_VALUES.has(token) || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

export async function storePrivateBlob({
  pathname,
  body,
  contentType,
  candidates,
  putImpl = put
}) {
  const errors = [];
  for (const candidate of candidates || []) {
    try {
      const blob = await putImpl(pathname, body, {
        access: "private",
        addRandomSuffix: false,
        contentType,
        token: candidate.token
      });
      return {
        stored: true,
        blobUrl: blob.url || "",
        blobPathname: blob.pathname || "",
        tokenKey: candidate.key,
        warning: ""
      };
    } catch (error) {
      errors.push(storageError(candidate.key, error));
    }
  }
  return {
    stored: false,
    blobUrl: "",
    blobPathname: "",
    tokenKey: "",
    warning: errors.length
      ? "The workbook downloaded, but its cloud archive could not be saved. Re-download is unavailable until Blob storage is reconnected."
      : ""
  };
}

export async function readPrivateBlob({
  location,
  candidates,
  getImpl = get
}) {
  const errors = [];
  for (const candidate of candidates || []) {
    try {
      const result = await getImpl(location, {
        access: "private",
        useCache: false,
        token: candidate.token
      });
      if (result?.statusCode === 200 && result.stream) {
        return { result, tokenKey: candidate.key };
      }
      errors.push(`${candidate.key}: stored object unavailable`);
    } catch (error) {
      errors.push(storageError(candidate.key, error));
    }
  }
  const failure = new Error(
    errors.length
      ? "Stored export is unavailable because Blob storage is not connected correctly. Re-run the export to download a new copy."
      : "Stored export is unavailable because Blob storage is not configured."
  );
  failure.status = 503;
  throw failure;
}

function storageError(key, error) {
  const message = String(error?.message || "storage request failed")
    .replace(/vercel_blob_rw_[A-Za-z0-9_=-]+/g, "[token]")
    .slice(0, 240);
  return `${key}: ${message}`;
}
