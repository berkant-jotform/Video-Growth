import fs from "node:fs/promises";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import { fetchWithTimeout } from "./fetch.js";

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const MAX_LINKED_WORKBOOKS = 30;

export async function readSpreadsheetValues({ spreadsheetId, config, preferPublicCsv = false, skipSheetNames = [], skipTabs = [] }) {
  if (!spreadsheetId) return [];
  let apiError = null;
  if (hasSheetsApiAuth(config)) {
    try {
      return await readWorkbookGraph({
        spreadsheetId,
        readWorkbook: (workbookId) => readSpreadsheetValuesWithApi({ spreadsheetId: workbookId, config, skipSheetNames, skipTabs })
      });
    } catch (error) {
      apiError = error;
    }
  }
  let csvError = null;
  if (preferPublicCsv) {
    try {
      return await readWorkbookGraph({
        spreadsheetId,
        readWorkbook: (workbookId) => readSpreadsheetValuesFromPublicCsvTabs({ spreadsheetId: workbookId, skipSheetNames, skipTabs })
      });
    } catch (error) {
      csvError = error;
    }
  }
  try {
    return await readWorkbookGraph({
      spreadsheetId,
      readWorkbook: (workbookId) => readSpreadsheetValuesFromPublicXlsx({ spreadsheetId: workbookId, skipSheetNames, skipTabs })
    });
  } catch (fallbackError) {
    if (!preferPublicCsv) {
      try {
        const sheets = await readWorkbookGraph({
          spreadsheetId,
          readWorkbook: (workbookId) => readSpreadsheetValuesFromPublicCsvTabs({ spreadsheetId: workbookId, skipSheetNames, skipTabs })
        });
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

async function readSpreadsheetValuesWithApi({ spreadsheetId, config, skipSheetNames = [], skipTabs = [] }) {
  const auth = await createSheetsAuth(config);
  const sheetsApi = google.sheets({ version: "v4", auth });
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))"
  }, {
    timeout: 20_000
  });
  const tabs = (metadata.data.sheets || [])
    .map((sheet) => ({ title: sheet.properties?.title || "", externalTabId: String(sheet.properties?.sheetId ?? "") }))
    .filter((sheet) => sheet.title);
  if (!tabs.length) return [];
  const activeTitles = tabs
    .filter((tab) => !sheetIsSkipped({ ...tab, spreadsheetId }, skipSheetNames, skipTabs))
    .map((tab) => tab.title);
  if (!activeTitles.length) {
    return tabs.map((tab) => ({ ...tab, values: [], spreadsheetId, skippedByPolicy: true, readStatus: "skipped" }));
  }
  const ranges = activeTitles.map((title) => quoteSheetName(title));
  const values = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: "ROWS"
  }, {
    timeout: 30_000
  });
  const formulas = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: "ROWS",
    valueRenderOption: "FORMULA"
  }, {
    timeout: 30_000
  }).catch(() => ({ data: { valueRanges: [] } }));
  const valuesByTitle = new Map(
    (values.data.valueRanges || []).map((range, idx) => [activeTitles[idx], range.values || []])
  );
  const result = tabs.map((tab) => ({
    ...tab,
    values: valuesByTitle.get(tab.title) || [],
    spreadsheetId,
    skippedByPolicy: sheetIsSkipped({ ...tab, spreadsheetId }, skipSheetNames, skipTabs),
    readStatus: sheetIsSkipped({ ...tab, spreadsheetId }, skipSheetNames, skipTabs) ? "skipped" : "fresh"
  }));
  result.linkedSpreadsheetIds = extractLinkedSpreadsheetIds(
    (formulas.data.valueRanges || []).flatMap((range) => range.values || [])
  );
  return result;
}

async function readSpreadsheetValuesFromPublicXlsx({ spreadsheetId, skipSheetNames = [], skipTabs = [] }) {
  const buffer = await downloadPublicSpreadsheetBuffer({ spreadsheetId });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const result = workbook.worksheets.map((worksheet) => ({
    title: worksheet.name,
    externalTabId: String(worksheet.id ?? ""),
    values: sheetIsSkipped({ spreadsheetId, title: worksheet.name }, skipSheetNames, skipTabs) ? [] : worksheetToValues(worksheet),
    spreadsheetId,
    skippedByPolicy: sheetIsSkipped({ spreadsheetId, title: worksheet.name }, skipSheetNames, skipTabs),
    readStatus: sheetIsSkipped({ spreadsheetId, title: worksheet.name }, skipSheetNames, skipTabs) ? "skipped" : "fresh"
  }));
  result.linkedSpreadsheetIds = extractWorkbookLinkedSpreadsheetIds(workbook);
  return result;
}

async function readSpreadsheetValuesFromPublicCsvTabs({
  spreadsheetId,
  skipSheetNames = [],
  skipTabs = []
}) {
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
  const tabs = extractPublicSheetTabs(html);
  if (!tabs.length) throw new Error("Google did not expose any readable sheet tabs.");
  const activeTitleCount = tabs.filter((tab) => !sheetIsSkipped({ ...tab, spreadsheetId }, skipSheetNames, skipTabs)).length;
  const warnings = [];
  const tabReadFailures = [];
  const sheets = await mapInBatches(tabs, 6, async (tab) => {
      if (sheetIsSkipped({ ...tab, spreadsheetId }, skipSheetNames, skipTabs)) {
        return { ...tab, values: [], spreadsheetId, skippedByPolicy: true, readStatus: "skipped" };
      }
      const tabQuery = tab.externalTabId
        ? `gid=${encodeURIComponent(tab.externalTabId)}`
        : `sheet=${encodeURIComponent(tab.title)}`;
      const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&${tabQuery}`;
      try {
        const response = await fetchWithTimeout(csvUrl, { redirect: "follow", timeoutMs: 25_000 });
        const csv = await response.text();
        if (!response.ok || (response.headers.get("content-type") || "").includes("text/html")) {
          throw new Error(`HTTP ${response.status}`);
        }
        return {
          ...tab,
          values: await parsePublicCsvValues(csv),
          spreadsheetId,
          readStatus: "fresh"
        };
      } catch (error) {
        tabReadFailures.push({ spreadsheetId, title: tab.title, externalTabId: tab.externalTabId, error: error.message });
        warnings.push(`Tab "${tab.title}" could not be refreshed and its cached rows were preserved: ${error.message}`);
        return { ...tab, values: [], spreadsheetId, readError: error.message, readStatus: "failed" };
      }
    });
  if (tabReadFailures.length && tabReadFailures.length === activeTitleCount) {
    throw new Error(`No active tab could be read from spreadsheet ${spreadsheetId}.`);
  }
  sheets.readWarnings = warnings;
  sheets.readIncomplete = tabReadFailures.length > 0;
  sheets.missingLinkedWorkbooks = [];
  sheets.tabReadFailures = tabReadFailures;
  return sheets;
}

export async function readWorkbookGraph({ spreadsheetId, readWorkbook, maxWorkbooks = MAX_LINKED_WORKBOOKS }) {
  const rootId = String(spreadsheetId || "").trim();
  if (!rootId) return [];
  const queue = [{ spreadsheetId: rootId, parentSpreadsheetId: "", linkedFrom: "" }];
  const visited = new Set();
  const sheets = [];
  const warnings = [];
  const missingLinkedWorkbooks = [];
  const tabReadFailures = [];
  const workbookReports = [];

  while (queue.length && visited.size < maxWorkbooks) {
    const item = queue.shift();
    if (!item?.spreadsheetId || visited.has(item.spreadsheetId)) continue;
    visited.add(item.spreadsheetId);
    let workbookSheets;
    try {
      workbookSheets = await readWorkbook(item.spreadsheetId);
    } catch (error) {
      if (item.spreadsheetId === rootId) throw error;
      missingLinkedWorkbooks.push({ spreadsheetId: item.spreadsheetId, linkedFrom: item.linkedFrom, error: error.message });
      warnings.push(`Linked workbook in "${item.linkedFrom || "configured sources"}" could not be read. Existing cached rows from that workbook were preserved. ${error.message}`);
      workbookReports.push({ spreadsheetId: item.spreadsheetId, parentSpreadsheetId: item.parentSpreadsheetId, linkedFrom: item.linkedFrom, status: "failed", error: error.message, tabs: [] });
      continue;
    }
    const annotated = (workbookSheets || []).map((sheet) => ({
      ...sheet,
      spreadsheetId: sheet.spreadsheetId || item.spreadsheetId,
      linkedFrom: sheet.linkedFrom || item.linkedFrom
    }));
    sheets.push(...annotated);
    warnings.push(...(workbookSheets.readWarnings || []));
    tabReadFailures.push(...(workbookSheets.tabReadFailures || []));
    workbookReports.push({
      spreadsheetId: item.spreadsheetId,
      parentSpreadsheetId: item.parentSpreadsheetId,
      linkedFrom: item.linkedFrom,
      status: workbookSheets.readIncomplete ? "partial" : "fresh",
      tabs: annotated.map((sheet) => ({
        title: sheet.title,
        externalTabId: sheet.externalTabId || "",
        status: sheet.readStatus || (sheet.readError ? "failed" : sheet.skippedByPolicy ? "skipped" : "fresh")
      }))
    });
    for (const sheet of annotated) {
      for (const linkedId of extractLinkedSpreadsheetIds(sheet.values)) {
        if (!visited.has(linkedId)) queue.push({ spreadsheetId: linkedId, parentSpreadsheetId: item.spreadsheetId, linkedFrom: sheet.title });
      }
    }
    for (const linkedId of workbookSheets.linkedSpreadsheetIds || []) {
      if (!visited.has(linkedId)) queue.push({ spreadsheetId: linkedId, parentSpreadsheetId: item.spreadsheetId, linkedFrom: item.linkedFrom || "workbook link" });
    }
  }
  if (queue.length) warnings.push(`Stopped linked-workbook discovery after ${maxWorkbooks} workbooks. Review the source graph for accidental cycles or excessive links.`);
  sheets.readWarnings = warnings;
  sheets.readIncomplete = missingLinkedWorkbooks.length > 0 || tabReadFailures.length > 0 || queue.length > 0;
  sheets.missingLinkedWorkbooks = missingLinkedWorkbooks;
  sheets.tabReadFailures = tabReadFailures;
  sheets.workbookReports = workbookReports;
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

function sheetIsSkipped(sheet, skipSheetNames = [], skipTabs = []) {
  if (normalizedSheetNameSet(skipSheetNames).has(normalizeSheetName(sheet.title))) return true;
  return (skipTabs || []).some((policy) => {
    const workbookId = String(policy.spreadsheetId || "").trim();
    if (workbookId && workbookId !== String(sheet.spreadsheetId || "").trim()) return false;
    const externalTabId = String(policy.externalTabId || "").trim();
    if (externalTabId) return externalTabId === String(sheet.externalTabId || "").trim();
    return normalizeSheetName(policy.sheetName) === normalizeSheetName(sheet.title);
  });
}

function normalizeSheetName(value) {
  return String(value || "").trim().toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
}

export function extractPublicSheetTabs(html) {
  const source = String(html || "");
  const tabs = [];
  const pattern = /<div class="goog-inline-block docs-sheet-tab-caption">([\s\S]*?)<\/div>/g;
  for (const match of source.matchAll(pattern)) {
    const title = decodeHtmlEntities(match[1]).replace(/<[^>]+>/g, "").trim();
    if (!title || tabs.some((tab) => tab.title === title)) continue;
    const prefix = source.slice(Math.max(0, Number(match.index || 0) - 600), Number(match.index || 0));
    const idMatches = [...prefix.matchAll(/(?:data-sheet-id|data-sheet-gid|data-gid)="(\d+)"/g)];
    tabs.push({ title, externalTabId: idMatches.at(-1)?.[1] || "" });
  }
  return tabs;
}

export function extractPublicSheetTitles(html) {
  return extractPublicSheetTabs(html).map((tab) => tab.title);
}

export function extractLinkedSpreadsheetIds(values = []) {
  const ids = new Set();
  for (const row of values || []) {
    for (const cell of row || []) {
      for (const match of String(cell || "").matchAll(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/gi)) {
        if (match?.[1]) ids.add(match[1]);
        if (ids.size >= MAX_LINKED_WORKBOOKS) return Array.from(ids);
      }
    }
  }
  return Array.from(ids);
}

function extractWorkbookLinkedSpreadsheetIds(workbook) {
  const ids = new Set();
  for (const worksheet of workbook.worksheets || []) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        const candidates = [
          typeof value === "string" ? value : "",
          value?.hyperlink,
          value?.formula,
          value?.sharedFormula,
          value?.text
        ];
        for (const linkedId of extractLinkedSpreadsheetIds([candidates])) ids.add(linkedId);
      });
    });
  }
  return Array.from(ids).slice(0, MAX_LINKED_WORKBOOKS);
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
