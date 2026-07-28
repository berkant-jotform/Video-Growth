import assert from "node:assert/strict";
import test from "node:test";
import {
  blobTokenCandidates,
  readPrivateBlob,
  storePrivateBlob
} from "../lib/blob-storage.js";

test("Blob candidates fall back to the integration-managed BLOBP token", () => {
  const original = process.env.BLOBP_READ_WRITE_TOKEN;
  process.env.BLOBP_READ_WRITE_TOKEN = "vercel_blob_rw_integration_token";
  try {
    assert.deepEqual(
      blobTokenCandidates({ blobReadWriteToken: "vercel_blob_rw_manual_token" })
        .map((item) => item.key),
      ["BLOB_READ_WRITE_TOKEN", "BLOBP_READ_WRITE_TOKEN"]
    );
  } finally {
    restoreEnv("BLOBP_READ_WRITE_TOKEN", original);
  }
});

test("Blob upload retries the integration token after an invalid manual token", async () => {
  const attempts = [];
  const result = await storePrivateBlob({
    pathname: "history-exports/test.xlsx",
    body: Buffer.from("test"),
    contentType: "application/octet-stream",
    candidates: [
      { key: "BLOB_READ_WRITE_TOKEN", token: "invalid" },
      { key: "BLOBP_READ_WRITE_TOKEN", token: "valid" }
    ],
    putImpl: async (_pathname, _body, options) => {
      attempts.push(options.token);
      if (options.token === "invalid") throw new Error("Vercel Blob: Access denied");
      return { url: "https://blob.example/test.xlsx", pathname: "test.xlsx" };
    }
  });

  assert.deepEqual(attempts, ["invalid", "valid"]);
  assert.equal(result.stored, true);
  assert.equal(result.tokenKey, "BLOBP_READ_WRITE_TOKEN");
  assert.equal(result.warning, "");
});

test("Blob upload failure becomes a download-only warning instead of throwing", async () => {
  const result = await storePrivateBlob({
    pathname: "history-exports/test.xlsx",
    body: Buffer.from("test"),
    contentType: "application/octet-stream",
    candidates: [{ key: "BLOB_READ_WRITE_TOKEN", token: "invalid" }],
    putImpl: async () => {
      throw new Error("Vercel Blob: Access denied");
    }
  });

  assert.equal(result.stored, false);
  assert.equal(result.blobUrl, "");
  assert.match(result.warning, /workbook downloaded/i);
});

test("Stored export reads retry all configured Blob tokens", async () => {
  const attempts = [];
  const stream = { getReader() {} };
  const { result, tokenKey } = await readPrivateBlob({
    location: "https://blob.example/test.xlsx",
    candidates: [
      { key: "BLOB_READ_WRITE_TOKEN", token: "invalid" },
      { key: "BLOBP_READ_WRITE_TOKEN", token: "valid" }
    ],
    getImpl: async (_location, options) => {
      attempts.push(options.token);
      if (options.token === "invalid") throw new Error("Access denied");
      return {
        statusCode: 200,
        stream,
        blob: { contentType: "application/octet-stream" }
      };
    }
  });

  assert.deepEqual(attempts, ["invalid", "valid"]);
  assert.equal(tokenKey, "BLOBP_READ_WRITE_TOKEN");
  assert.equal(result.stream, stream);
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
