import sharp from "sharp";
import { getPreviewBlob, isVercelBlobUrl } from "@/lib/blob.js";
import { fetchWithTimeout } from "./fetch.js";

const signatureCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function enrichThumbnailMatches(records, config, { concurrency = 4 } = {}) {
  const eligible = records.filter((record) =>
    record.testType === "thumbnail" &&
    !["result_logged", "sheet_marked_done"].includes(record.status) &&
    record.currentYoutubeThumbnailUrl &&
    ["B", "C"].some((option) => record.thumbnailPreviews?.[option])
  );
  const warnings = [];
  let matched = 0;
  let index = 0;

  async function worker() {
    while (index < eligible.length) {
      const record = eligible[index++];
      try {
        const result = await compareThumbnailOptions(record, config);
        if (!result?.option) continue;
        record.matchedThumbnailOption = result.option;
        record.thumbnailMatchConfidence = result.confidence;
        record.thumbnailMatchDistance = result.distance;
        matched += 1;
      } catch (error) {
        warnings.push(`Thumbnail comparison skipped for ${record.videoId || record.videoTitle || "one row"}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, () => worker()));
  return { records, matched, warnings: warnings.slice(0, 8) };
}

export async function compareThumbnailOptions(record, config) {
  const current = await signatureForUrl(record.currentYoutubeThumbnailUrl, config);
  const comparisons = [];
  for (const option of ["A", "B", "C"]) {
    const url = record.thumbnailPreviews?.[option];
    if (!url) continue;
    const signature = await signatureForUrl(url, config);
    comparisons.push({ option, distance: signatureDistance(current, signature) });
  }
  comparisons.sort((a, b) => a.distance - b.distance);
  const best = comparisons[0];
  const second = comparisons[1];
  if (!best) return null;
  const margin = second ? second.distance - best.distance : 1;
  const confident = best.distance <= 0.12 || (best.distance <= 0.2 && margin >= 0.05);
  if (!confident) return null;
  return {
    option: best.option,
    distance: Number(best.distance.toFixed(4)),
    confidence: best.distance <= 0.08 ? "high" : "medium",
    comparisons
  };
}

async function signatureForUrl(url, config) {
  const cached = signatureCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.signature;
  const buffer = await readImage(url, config);
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(17, 9, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grayscale = [];
  const colors = [];
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset];
    const green = data[offset + 1] ?? red;
    const blue = data[offset + 2] ?? red;
    grayscale.push(Math.round(red * 0.299 + green * 0.587 + blue * 0.114));
    colors.push(red, green, blue);
  }
  const gradients = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const offset = row * 17 + column;
      gradients.push(grayscale[offset] > grayscale[offset + 1] ? 1 : 0);
    }
  }
  const signature = { gradients, colors };
  signatureCache.set(url, { fetchedAt: Date.now(), signature });
  return signature;
}

function signatureDistance(left, right) {
  const gradientDiff = left.gradients.reduce(
    (count, value, index) => count + (value === right.gradients[index] ? 0 : 1),
    0
  ) / Math.max(1, left.gradients.length);
  const colorDiff = left.colors.reduce(
    (sum, value, index) => sum + Math.abs(value - right.colors[index]),
    0
  ) / Math.max(1, left.colors.length * 255);
  return gradientDiff * 0.72 + colorDiff * 0.28;
}

async function readImage(url, config) {
  if (isVercelBlobUrl(url)) {
    if (!config?.blobReadWriteToken) throw new Error("Blob token is missing.");
    const result = await getPreviewBlob(url, { token: config.blobReadWriteToken });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Stored preview was not found.");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  const response = await fetchWithTimeout(url, {
    timeoutMs: 12_000,
    headers: { Accept: "image/*" }
  });
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) throw new Error("Preview URL did not return an image.");
  return Buffer.from(await response.arrayBuffer());
}
