import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import { fetchWithTimeout } from "./fetch.js";

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export async function readSpreadsheetValues({ spreadsheetId, config }) {
  if (!spreadsheetId) return [];
  let apiError = null;
  if (hasSheetsApiAuth(config)) {
    try {
      return await readSpreadsheetValuesWithApi({ spreadsheetId, config });
    } catch (error) {
      apiError = error;
    }
  }
  try {
    return await readSpreadsheetValuesFromPublicXlsx({ spreadsheetId });
  } catch (fallbackError) {
    if (apiError) {
      fallbackError.message = `${apiError.message}\n\nPublic XLSX fallback also failed: ${fallbackError.message}`;
    }
    throw fallbackError;
  }
}

async function readSpreadsheetValuesWithApi({ spreadsheetId, config }) {
  const auth = await createSheetsAuth(config);
  const sheetsApi = google.sheets({ version: "v4", auth });
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))"
  }, {
    timeout: 20_000
  });
  const titles =
    metadata.data.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean) || [];
  if (!titles.length) return [];
  const ranges = titles.map((title) => quoteSheetName(title));
  const values = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: "ROWS"
  }, {
    timeout: 30_000
  });
  return (values.data.valueRanges || []).map((range, idx) => ({
    title: titles[idx] || range.range || `Sheet ${idx + 1}`,
    values: range.values || []
  }));
}

async function readSpreadsheetValuesFromPublicXlsx({ spreadsheetId }) {
  const buffer = await downloadPublicSpreadsheetBuffer({ spreadsheetId });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets.map((worksheet) => ({
    title: worksheet.name,
    values: worksheetToValues(worksheet)
  }));
}

export async function downloadPublicSpreadsheetBuffer({ spreadsheetId }) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=xlsx`;
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    timeoutMs: 45_000,
    headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || contentType.includes("text/html")) {
    const detail = response.ok ? "Google returned a sign-in or error page." : `HTTP ${response.status}`;
    const error = new Error(
      `${detail} Share the cloned Google Sheet as "Anyone with the link: Viewer", then scan again.`
    );
    error.status = response.status || 503;
    throw error;
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 220 * 1024 * 1024) {
    const error = new Error("The exported workbook is larger than 220 MB. Upload a smaller XLSX snapshot from the Uploads page.");
    error.status = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 220 * 1024 * 1024) {
    const error = new Error("The exported workbook is larger than 220 MB. Upload a smaller XLSX snapshot from the Uploads page.");
    error.status = 413;
    throw error;
  }
  return buffer;
}

function worksheetToValues(worksheet) {
  const values = Array.from({ length: worksheet.rowCount || 0 }, () => []);
  const columnCount = Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0);
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const out = [];
    for (let col = 1; col <= columnCount; col += 1) {
      out.push(normalizeCellValue(row.getCell(col).value));
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    values[rowNumber - 1] = out;
  });
  return values;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return String(value).trim();
  if (Array.isArray(value.richText)) {
    return value.richText.map((item) => item.text || "").join("").trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "result")) {
    return normalizeCellValue(value.result);
  }
  if (Object.prototype.hasOwnProperty.call(value, "hyperlink")) {
    return [normalizeCellValue(value.text), normalizeCellValue(value.hyperlink)]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "text")) {
    return normalizeCellValue(value.text);
  }
  return String(value).trim();
}

function hasSheetsApiAuth(config) {
  return Boolean(
    config?.googleServiceAccountJson ||
      config?.googleServiceAccountFile ||
      config?.googleOauthAccessToken
  );
}

async function createSheetsAuth(config) {
  if (config.googleServiceAccountJson || config.googleServiceAccountFile) {
    const credentials = config.googleServiceAccountJson
      ? JSON.parse(config.googleServiceAccountJson)
      : JSON.parse(await fs.readFile(config.googleServiceAccountFile, "utf8"));
    return new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [SHEETS_READONLY_SCOPE]
    });
  }
  if (config.googleOauthAccessToken) {
    const oauth = new google.auth.OAuth2();
    oauth.setCredentials({ access_token: config.googleOauthAccessToken });
    return oauth;
  }
  const error = new Error("Google Sheets read-only auth is not configured.");
  error.status = 503;
  throw error;
}

function quoteSheetName(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}
