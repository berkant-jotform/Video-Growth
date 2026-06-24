import fs from "node:fs/promises";
import { google } from "googleapis";

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export async function readSpreadsheetValues({ spreadsheetId, config }) {
  if (!spreadsheetId) return [];
  const auth = await createSheetsAuth(config);
  const sheetsApi = google.sheets({ version: "v4", auth });
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))"
  });
  const titles =
    metadata.data.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean) || [];
  if (!titles.length) return [];
  const ranges = titles.map((title) => quoteSheetName(title));
  const values = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: "ROWS"
  });
  return (values.data.valueRanges || []).map((range, idx) => ({
    title: titles[idx] || range.range || `Sheet ${idx + 1}`,
    values: range.values || []
  }));
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
