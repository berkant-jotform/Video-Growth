import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { put } from "@vercel/blob";
import { saveThumbnailPreview, saveUpload } from "@/lib/repository.js";

export async function importThumbnailWorkbook({ file, sourceKind = "thumbnail", blobToken = "" }) {
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
  const row = worksheet.getRow(1);
  row.eachCell((cell, colNumber) => {
    const text = String(cell.value || "").trim().toLowerCase();
    const match = text.match(/^thumbnail\s+([abc])$/);
    if (match) map.set(colNumber, match[1].toUpperCase());
  });
  return map;
}

function findMedia(workbook, imageId) {
  return workbook.model.media?.find((item) => item.index === imageId || item.name === imageId);
}

async function storeImage({ buffer, contentType, uploadId, sheetName, rowNumber, option, blobToken }) {
  const extension = contentType.split("/")[1] || "png";
  const filename = `thumbnail-previews/${uploadId}/${slug(sheetName)}-${rowNumber}-${option}.${extension}`;
  if (blobToken) {
    const blob = await put(filename, buffer, {
      access: "public",
      contentType,
      token: blobToken
    });
    return blob.url;
  }
  return "";
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
