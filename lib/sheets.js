import fs from "node:fs/promises";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import { fetchWithTimeout } from "./fetch.js";

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export async function readSpreadsheetValues({ spreadsheetId, config, preferPublicCsv = false, skipSheetNames = [] }) {
  if (!spreadsheetId) return [];
  let apiError = null;
  if (hasSheetsApiAuth(config)) {
    try {
      return await readSpreadsheetValuesWithApi({ spreadsheetId, config, skipSheetNames });
    } catch (error) {
      apiError = error;
    }
  }
  let csvError = null;
  if (preferPublicCsv) {
    try {
      return await readSpreadsheetValuesFromPublicCsvTabs({ spreadsheetId, skipSheetNames });
    } catch (error) {
      csvError = error;
    }
  }
  try {
    return await readSpreadsheetValuesFromPublicXlsx({ spreadsheetId, skipSheetNames });
  } catch (fallbackError) {
    if (!preferPublicCsv) {
      try {
        const sheets = await readSpreadsheetValuesFromPublicCsvTabs({ spreadsheetId, skipSheetNames });
        sheets.readWarnings = [
          `Used lightweight per-tab CSV because the XLSX workbook could not be read: ${fallbackError.message}`,
          ...(sheets.readWarnings || [])
        ];
        return sheets;
      } catch (error) {
        csvError = error;
      }
    }
    const messages = [
      apiError ? `Google Sheets API failed: ${apiError.message}` : "",
      csvError ? `Public per-tab CSV fallback failed: ${csvError.message}` : "",
      `Public XLSX fallback failed: ${fallbackError.message}`
    ].filter(Boolean);
    fallbackError.message = messages.join("\n\n");
    throw fallbackError;
  }
}

async function readSpreadsheetValuesWithApi({ spreadsheetId, config, skipSheetNames = [] }) {
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
  const skipped = normalizedSheetNameSet(skipSheetNames);
  const activeTitles = titles.filter((title) => !skipped.has(normalizeSheetName(title)));
  if (!activeTitles.length) {
    return titles.map((title) => ({ title, values: [], spreadsheetId, skippedByPolicy: true }));
  }
  const ranges = activeTitles.map((title) => quoteSheetName(title));
  const values = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: "ROWS"
  }, {
    timeout: 30_000
  });
  const valuesByTitle = new Map(
    (values.data.valueRanges || []).map((range, idx) => [activeTitles[idx], range.values || []])
  );
  return titles.map((title) => ({
    title,
    values: valuesByTitle.get(title) || [],
    spreadsheetId,
    skippedByPolicy: skipped.has(normalizeSheetName(title))
  }));
}

async function readSpreadsheetValuesFromPublicXlsx({ spreadsheetId, skipSheetNames = [] }) {
  const buffer = await downloadPublicSpreadsheetBuffer({ spreadsheetId });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const skipped = normalizedSheetNameSet(skipSheetNames);
  return workbook.worksheets.map((worksheet) => ({
    title: worksheet.name,
    values: skipped.has(normalizeSheetName(worksheet.name)) ? [] : worksheetToValues(worksheet),
    spreadsheetId,
    skippedByPolicy: skipped.has(normalizeSheetName(worksheet.name))
  }));
}

async function readSpreadsheetValuesFromPublicCsvTabs({
  spreadsheetId,
  skipSheetNames = [],
  depth = 0,
  visited = new Set()
}) {
  if (!spreadsheetId || visited.has(spreadsheetId)) return [];
  visited.add(spreadsheetId);
  const editUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit?usp=sharing`;
  const page = await fetchWithTimeout(editUrl, { redirect: "follow", timeoutMs: 25_000 });
  const html = await page.text();
  if (!page.ok || !html.includes("docs-sheet-tab-caption")) {
    const error = new Error(
      `Spreadsheet ${spreadsheetId} is not publicly readable. Share it as "Anyone with the link: Viewer".`
    );
    error.status = page.status || 503;
    throw error;
  }
  const titles = extractPublicSheetTitles(html);
  if (!titles.length) throw new Error("Google did not expose any readable sheet tabs.");
  const skipped = normalizedSheetNameSet(skipSheetNames);
  const activeTitleCount = titles.filter((title) => !skipped.has(normalizeSheetName(title))).length;
  const warnings = [];
  const tabReadFailures = [];
  const sheets = await mapInBatches(titles, 6, async (title) => {
      if (skipped.has(normalizeSheetName(title))) {
        return { title, values: [], spreadsheetId, skippedByPolicy: true };
      }
      const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(title)}`;
      try {
        const response = await fetchWithTimeout(csvUrl, { redirect: "follow", timeoutMs: 25_000 });
        const csv = await response.text();
        if (!response.ok || (response.headers.get("content-type") || "").includes("text/html")) {
          throw new Error(`HTTP ${response.status}`);
        }
        return {
          title,
          values: await parsePublicCsvValues(csv),
          spreadsheetId
        };
      } catch (error) {
        tabReadFailures.push({ spreadsheetId, title, error: error.message });
        warnings.push(`Tab "${title}" could not be refreshed and its cached rows were preserved: ${error.message}`);
        return { title, values: [], spreadsheetId, readError: error.message };
      }
    });
  if (tabReadFailures.length && tabReadFailures.length === activeTitleCount) {
    throw new Error(`No active tab could be read from spreadsheet ${spreadsheetId}.`);
  }
  const missingLinkedWorkbooks = [];
  if (depth < 1) {
    for (const sheet of [...sheets]) {
      for (const linkedId of extractLinkedSpreadsheetIds(sheet.values)) {
        if (visited.has(linkedId)) continue;
        try {
          const linkedSheets = await readSpreadsheetValuesFromPublicCsvTabs({
            spreadsheetId: linkedId,
            skipSheetNames,
            depth: depth + 1,
            visited
          });
          sheets.push(...linkedSheets.map((linked) => ({ ...linked, linkedFrom: sheet.title })));
          warnings.push(...(linkedSheets.readWarnings || []));
          missingLinkedWorkbooks.push(...(linkedSheets.missingLinkedWorkbooks || []));
        } catch (error) {
          missingLinkedWorkbooks.push({
            spreadsheetId: linkedId,
            linkedFrom: sheet.title,
            error: error.message
          });
          warnings.push(
            `Linked workbook in "${sheet.title}" could not be read. Existing cached rows from that workbook were preserved. ${error.message}`
          );
        }
      }
    }
  }
  sheets.readWarnings = warnings;
  sheets.readIncomplete = missingLinkedWorkbooks.length > 0 || tabReadFailures.length > 0;
  sheets.missingLinkedWorkbooks = missingLinkedWorkbooks;
  sheets.tabReadFailures = tabReadFailures;
  return sheets;
}

async function mapInBatches(items, batchSize, mapper) {
  const output = [];
  for (let index = 0; index < items.length; index += batchSize) {
    output.push(...await Promise.all(items.slice(index, index + batchSize).map(mapper)));
  }
  return output;
}

function normalizedSheetNameSet(values = []) {
  return new Set(values.map(normalizeSheetName).filter(Boolean));
}

function normalizeSheetName(value) {
  return String(value || "").trim().toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
}

export function extractPublicSheetTitles(html) {
  const titles = [];
  const pattern = /<div class="goog-inline-block docs-sheet-tab-caption">([\s\S]*?)<\/div>/g;
  for (const match of String(html || "").matchAll(pattern)) {
    const title = decodeHtmlEntities(match[1]).replace(/<[^>]+>/g, "").trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

export function extractLinkedSpreadsheetIds(values = []) {
  const ids = new Set();
  for (const row of values.slice(0, 12)) {
    for (const cell of (row || []).slice(0, 12)) {
      const match = String(cell || "").match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/i);
      if (match?.[1]) ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

export async function parsePublicCsvValues(csv) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(Readable.from([String(csv || "")]));
  return worksheetToValues(worksheet);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
      out.push(normalizeSheetCellValue(row.getCell(col).value));
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    values[rowNumber - 1] = out;
  });
  return values;
}

export function normalizeSheetCellValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return String(value).trim();
  if (Array.isArray(value.richText)) {
    return value.richText.map((item) => item.text || "").join("").trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "result")) {
    return normalizeSheetCellValue(value.result);
  }
  if (Object.prototype.hasOwnProperty.call(value, "hyperlink")) {
    return [normalizeSheetCellValue(value.text), normalizeSheetCellValue(value.hyperlink)]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "text")) {
    return normalizeSheetCellValue(value.text);
  }
  return "";
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
