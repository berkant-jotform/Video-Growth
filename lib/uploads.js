import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { normalizeHeader } from "@/lib/domain.mjs";
import { putPreviewBlob } from "@/lib/blob.js";
import { saveThumbnailPreview, saveUpload } from "@/lib/repository.js";

const MAX_WORKBOOK_BYTES = 220 * 1024 * 1024;

export async function importThumbnailWorkbook({ file, sourceKind = "thumbnail", blobToken = "" }) {
  if (Number(file.size || 0) > MAX_WORKBOOK_BYTES) {
    const error = new Error("The XLSX snapshot is larger than 220 MB. Export only the active thumbnail tabs and upload that smaller file.");
    error.status = 413;
    throw error;
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return importThumbnailWorkbookBuffer({
    buffer,
    filename: file.name || "thumbnail-snapshot.xlsx",
    sourceKind,
    blobToken
  });
}

export async function importThumbnailWorkbookBuffer({
  buffer,
  filename = "thumbnail-snapshot.xlsx",
  sourceKind = "thumbnail",
  blobToken = "",
  uploadId = crypto.randomUUID(),
  saveUploadRecord = true
}) {
  if (!buffer?.length) {
    const error = new Error("The uploaded XLSX file is empty.");
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_WORKBOOK_BYTES) {
    const error = new Error("The XLSX snapshot is larger than 220 MB. Export only the active thumbnail tabs and upload that smaller file.");
    error.status = 413;
    throw error;
  }
  if (!blobToken) {
    const error = new Error("Vercel Blob is not configured. Add BLOB_READ_WRITE_TOKEN before importing thumbnail previews.");
    error.status = 503;
    throw error;
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  let importedCount = 0;
  for (const worksheet of workbook.worksheets) {
    const headerMap = thumbnailHeaderMap(worksheet);
    if (!headerMap.size) continue;
    for (const image of worksheet.getImages()) {
      const rowNumber = image.range?.tl?.nativeRow + 1;
      const colNumber = image.range?.tl?.nativeCol + 1;
      const option = headerMap.get(colNumber);
      if (!rowNumber || !option) continue;
      const media = findMedia(workbook, image.imageId);
      if (!media?.buffer) continue;
      const contentType = mediaContentType(media.extension);
      const url = await storeImage({
        buffer: media.buffer,
        contentType,
        uploadId,
        sheetName: worksheet.name,
        rowNumber,
        option,
        blobToken
      });
      if (!url) continue;
      await saveThumbnailPreview({
        sourceKind,
        sheetName: worksheet.name,
        rowNumber,
        option,
        url,
        contentType,
        uploadId
      });
      importedCount += 1;
    }
  }
  if (saveUploadRecord) {
    await saveUpload({
      uploadId,
      filename,
      sourceKind,
      importedCount
    });
  }
  return { uploadId, importedCount };
}

function thumbnailHeaderMap(worksheet) {
  const map = new Map();
  const limit = Math.min(Math.max(worksheet.rowCount || 0, 1), 40);
  for (let rowNumber = 1; rowNumber <= limit && map.size < 2; rowNumber += 1) {
    const candidate = new Map();
    worksheet.getRow(rowNumber).eachCell((cell, colNumber) => {
      const text = normalizeHeader(normalizeWorkbookCell(cell.value));
      const match = text.match(/^(?:thumbnail|image|option|variant)\s*[-:]?\s*([abc])$/) ||
        text.match(/^([abc])\s*[-:]?\s*(?:thumbnail|image)$/);
      if (match) candidate.set(colNumber, match[1].toUpperCase());
    });
    const options = new Set(candidate.values());
    if (options.has("A") && options.has("B")) {
      for (const [column, option] of candidate) map.set(column, option);
    }
  }
  return map;
}

function findMedia(workbook, imageId) {
  return workbook.model.media?.find((item) => item.index === imageId || item.name === imageId);
}

async function storeImage({ buffer, contentType, uploadId, sheetName, rowNumber, option, blobToken }) {
  const extension = contentType.split("/")[1] || "png";
  const filename = `thumbnail-previews/${uploadId}/${slug(sheetName)}-${rowNumber}-${option}.${extension}`;
  if (blobToken) {
    const blob = await putPreviewBlob(filename, buffer, { contentType, token: blobToken });
    return blob.url;
  }
  return "";
}

function normalizeWorkbookCell(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
  if (Object.prototype.hasOwnProperty.call(value, "text")) return String(value.text || "");
  if (Object.prototype.hasOwnProperty.call(value, "result")) return String(value.result || "");
  return String(value);
}

function mediaContentType(extension = "png") {
  const normalized = String(extension).replace(".", "").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  return "image/png";
}

function slug(value) {
  return String(value || "sheet")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
