import crypto from "node:crypto";
import { canonicalChannelName } from "./channels.mjs";

export const NO_CLEAR_WINNER_TEXT = "not enough impressions";
const VIDEO_ID_RE =
  /(?:youtu\.be\/|youtube\.com\/watch\?[^ ]*v=|youtube\.com\/shorts\/|studio\.youtube\.com\/video\/)([A-Za-z0-9_-]{6,})/;

export function extractVideoId(...values) {
  const joined = values.map((value) => String(value || "")).join(" ");
  const match = joined.match(VIDEO_ID_RE);
  return match ? match[1] : "";
}

export function extractSpreadsheetId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return text;
}

export function normalizeHeader(value) {
  return String(value || "")
    .replace(/\n/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-");
}

export function headerIndex(headers, names) {
  const normalized = headers.map(normalizeHeader);
  const wanted = names.map(normalizeHeader);
  const idx = normalized.findIndex((header) => wanted.includes(header));
  return idx >= 0 ? idx : null;
}

export function parseBool(value) {
  return ["true", "yes", "done", "1", "y"].includes(
    String(value || "").trim().toLowerCase()
  );
}

export function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return { date: value.toISOString().slice(0, 10), present: true };
  }

  const text = String(value || "").replace(/\u2009/g, " ").trim();
  if (!text || text === "-") return { date: "", present: false };

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s.*)?$/);
  if (iso) return buildDate(iso[1], iso[2], iso[3], true);

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    if (first > 12) return buildDate(slash[3], slash[2], slash[1], true);
    if (second > 12) return buildDate(slash[3], slash[1], slash[2], true);
    return buildDate(slash[3], slash[1], slash[2], true);
  }

  const parsed = new Date(`${text} UTC`);
  if (!Number.isNaN(parsed.valueOf())) {
    return { date: parsed.toISOString().slice(0, 10), present: true };
  }
  return { date: "", present: true };
}

function buildDate(year, month, day, present) {
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidate.getUTCFullYear() === Number(year) &&
    candidate.getUTCMonth() === Number(month) - 1 &&
    candidate.getUTCDate() === Number(day)
  ) {
    return { date: candidate.toISOString().slice(0, 10), present };
  }
  return { date: "", present };
}

export function addDays(dateText, days) {
  if (!dateText) return "";
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  if (!a || !b) return 0;
  const aDate = new Date(`${a}T00:00:00.000Z`);
  const bDate = new Date(`${b}T00:00:00.000Z`);
  if (Number.isNaN(aDate.valueOf()) || Number.isNaN(bDate.valueOf())) return 0;
  return Math.floor((bDate - aDate) / 86400000);
}

export function parseShare(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.toLowerCase().includes(NO_CLEAR_WINNER_TEXT)) return "no_clear_winner";
  const candidate = text.replace("%", "").trim();
  const number = Number(candidate);
  if (!Number.isFinite(number)) return text;
  if (text.includes("%") || number > 1) return number / 100;
  return number;
}

export function inferWinner(shares) {
  const numeric = Object.entries(shares).filter(([, value]) => typeof value === "number");
  if (numeric.length) {
    const [winner, value] = numeric.reduce((best, item) =>
      item[1] > best[1] ? item : best
    );
    return {
      suggestedWinner: winner,
      detectedOutcome: `winner_${winner.toLowerCase()}`,
      winnerReason: `Highest watch-time share: ${(value * 100).toFixed(1)}%`,
      resultEntered: true
    };
  }
  if (Object.values(shares).some((value) => value === "no_clear_winner")) {
    return {
      suggestedWinner: "",
      detectedOutcome: "no_clear",
      winnerReason: "No clear winner / not enough impressions.",
      resultEntered: true
    };
  }
  return {
    suggestedWinner: "",
    detectedOutcome: "result_missing",
    winnerReason: "",
    resultEntered: false
  };
}

export function detectTestType(headers, sourceKind = "") {
  const hasThumbnailPair = hasHeader(headers, thumbnailOptionHeaderNames("A")) && hasHeader(headers, thumbnailOptionHeaderNames("B"));
  const hasTitlePair = hasHeader(headers, titleOptionHeaderNames("A")) && hasHeader(headers, titleOptionHeaderNames("B"));
  if (sourceKind === "title" && hasTitlePair) {
    return "title";
  }
  if (sourceKind === "thumbnail" && hasThumbnailPair) {
    return "thumbnail";
  }
  if (hasHeader(headers, ["thumbnail a", "a thumbnail"]) && hasHeader(headers, ["thumbnail b", "b thumbnail"])) {
    return "thumbnail";
  }
  if (hasHeader(headers, ["title a", "a title"]) && hasHeader(headers, ["title b", "b title"])) {
    return "title";
  }
  if (
    sourceKind === "thumbnail" &&
    hasHeader(headers, ["Video URL", "Video Link", "YouTube URL", "Studio URL"]) &&
    hasHeader(headers, ["Thumbnail", "Thumb", "Image", "Image A", "Option A"])
  ) {
    return "thumbnail";
  }
  return null;
}

export function parseWorkbookRecords({ spreadsheetId, sourceKind, sheets, today }) {
  return sheets.flatMap((sheet) =>
    parseSheetRecords({
      spreadsheetId,
      sourceKind,
      sheetName: sheet.title || sheet.name || "",
      values: sheet.values || [],
      today
    })
  );
}

export function parseSheetRecords({ spreadsheetId, sourceKind, sheetName, values, today }) {
  if (!values?.length) return [];
  const headerRow = findHeaderRow(values, sourceKind);
  if (!headerRow) return [];
  const { headers, rowIndex: headerRowIndex, testType } = headerRow;

  const startIdx = headerIndex(headers, [
    "Published Date/ Test Start Date",
    "Test Start / Published Date",
    "Test Start Date",
    "Start Date",
    "Published Date",
    "Publish Date"
  ]);
  const finishIdx = headerIndex(headers, ["Test Finish Date", "Test End Date", "End Date", "Finish Date"]);
  const doneIdx = headerIndex(headers, ["Done", "Status", "Completed"]);
  const urlIdx = headerIndex(headers, ["Video URL", "Video Link", "YouTube URL", "Youtube URL", "URL", "Studio URL"]);
  const titleIdx = headerIndex(headers, [
    "Video Title",
    "Title",
    "Current Title",
    "Current Title (Title A)",
    "Current YouTube Title"
  ]);
  const optionIndices = optionColumns(headers, testType);
  const shareIndices = shareColumns(headers);

  return values.slice(headerRowIndex + 1).flatMap((row, offset) => {
    if (!rowHasSignal(row, [startIdx, finishIdx, urlIdx, titleIdx], optionIndices)) {
      return [];
    }
    return [
      buildTestRun({
        spreadsheetId,
        sourceKind,
        sheetName,
        rowNumber: headerRowIndex + offset + 2,
        row,
        headers,
        testType,
        today,
        startIdx,
        finishIdx,
        doneIdx,
        urlIdx,
        titleIdx,
        optionIndices,
        shareIndices
      })
    ];
  });
}

function optionColumns(headers, testType) {
  return Object.fromEntries(
    ["A", "B", "C"]
      .map((option) => [
        option,
        headerIndex(
          headers,
          testType === "thumbnail" ? thumbnailOptionHeaderNames(option) : titleOptionHeaderNames(option)
        )
      ])
      .filter(([, idx]) => idx !== null)
  );
}

function shareColumns(headers) {
  return Object.fromEntries(
    ["A", "B", "C"]
      .map((option) => [
        option,
        headerIndex(headers, [
          `${option} - Watch-Time Share`,
          `${option} Watch-Time Share`,
          `${option} Watch Time Share`,
          `Watch-Time Share ${option}`,
          `Watch Time Share ${option}`,
          `${option} Share`,
          `${option} Result`
        ])
      ])
      .filter(([, idx]) => idx !== null)
  );
}

function findHeaderRow(values, sourceKind) {
  const limit = Math.min(values.length, 12);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const headers = values[rowIndex] || [];
    const testType = detectTestType(headers, sourceKind);
    if (testType) return { rowIndex, headers, testType };
  }
  return null;
}

function hasHeader(headers, names) {
  return headerIndex(headers, names) !== null;
}

function thumbnailOptionHeaderNames(option) {
  return [
    `Thumbnail ${option}`,
    `${option} Thumbnail`,
    `${option} - Thumbnail`,
    `Thumbnail ${option} URL`,
    `${option} Thumbnail URL`,
    `Image ${option}`,
    `${option} Image`,
    `Option ${option}`,
    `Variant ${option}`,
    option
  ];
}

function titleOptionHeaderNames(option) {
  return [
    `Title ${option}`,
    `${option} Title`,
    `${option} - Title`,
    `Option ${option}`,
    `Variant ${option}`
  ];
}

function rowHasSignal(row, scalarIndices, optionIndices) {
  const indices = scalarIndices.filter((idx) => idx !== null);
  indices.push(...Object.values(optionIndices));
  return indices.some((idx) => {
    const text = String(row[idx] || "").trim();
    return text && !text.startsWith("=");
  });
}

function buildTestRun(args) {
  const {
    spreadsheetId,
    sourceKind,
    sheetName,
    rowNumber,
    row,
    headers,
    testType,
    today,
    startIdx,
    finishIdx,
    doneIdx,
    urlIdx,
    titleIdx,
    optionIndices,
    shareIndices
  } = args;
  const padded = Array.from({ length: Math.max(headers.length, row.length) }, (_, idx) => row[idx] ?? "");
  const videoId = extractVideoId(...padded);
  const start = parseDate(valueAt(padded, startIdx));
  const finish = parseDate(valueAt(padded, finishIdx));
  const startDate = start.date;
  const finishDate = finish.date;
  const effectiveFinishDate = finishDate;
  const options = Object.fromEntries(
    Object.entries(optionIndices)
      .map(([option, idx]) => [option, valueAt(padded, idx)])
      .filter(([, value]) => value)
  );
  const watchTimeShare = Object.fromEntries(
    Object.entries(shareIndices).map(([option, idx]) => [option, parseShare(valueAt(padded, idx))])
  );
  const winner = inferWinner(watchTimeShare);
  const troubles = detectTroubles({
    videoId,
    start,
    finish,
    testType,
    options,
    done: parseBool(valueAt(padded, doneIdx))
  });
  const status = classifyStatus({
    done: parseBool(valueAt(padded, doneIdx)),
    troubles,
    effectiveFinishDate,
    today,
    resultEntered: winner.resultEntered,
    detectedOutcome: winner.detectedOutcome
  });
  const optionFingerprint = hashStable(options);
  const sourcePayload = {
    spreadsheetId,
    sourceKind,
    sheetName,
    rowNumber,
    headers,
    row: padded
  };
  const rowFingerprint = hashStable({
    videoId,
    startDate,
    finishDate,
    options,
    watchTimeShare
  });
  const testRunId = makeTestRunId({
    spreadsheetId,
    sheetName,
    rowNumber,
    testType,
    videoId,
    startDate,
    finishDate,
    optionFingerprint
  });
  return {
    testRunId,
    videoId,
    spreadsheetId,
    sourceKind,
    sheetName,
    rowNumber,
    testType,
    channel: canonicalChannelName(sheetName) || sheetName,
    videoTitle: valueAt(padded, titleIdx),
    videoUrl: cleanVideoUrl(valueAt(padded, urlIdx), videoId),
    studioUrl: extractStudioUrl(...padded) || (videoId ? `https://studio.youtube.com/video/${videoId}/edit` : ""),
    startDate,
    finishDate,
    effectiveFinishDate,
    overdueDays:
      effectiveFinishDate && effectiveFinishDate < today && ["needs_review"].includes(status)
        ? daysBetween(effectiveFinishDate, today)
        : 0,
    options,
    watchTimeShare,
    suggestedWinner:
      winner.suggestedWinner || (winner.detectedOutcome === "no_clear" ? "No clear winner" : ""),
    detectedOutcome: winner.detectedOutcome,
    winnerReason: winner.winnerReason,
    status,
    troubles,
    optionFingerprint,
    rowFingerprint,
    sourcePayloadHash: hashStable(sourcePayload),
    sourcePayload,
    currentYoutubeTitle: "",
    currentYoutubeThumbnailUrl: "",
    youtubeChannelTitle: "",
    youtubeChannelThumbnailUrl: "",
    thumbnailPreviews: {}
  };
}

function detectTroubles({ videoId, start, finish, testType, options, done }) {
  const troubles = [];
  if (!videoId && !done) {
    troubles.push({
      severity: "error",
      code: "missing_video_id",
      message: "Could not find a YouTube video ID in the row.",
      suggestedFix: "Paste a youtu.be, youtube.com/watch, or Studio edit URL into the row."
    });
  }
  if (!start.date && !done) {
    troubles.push({
      severity: "error",
      code: start.present ? "unparseable_start_date" : "missing_start_date",
      message: "The row has no usable test start date.",
      suggestedFix: "Fill the test start date in the first date column."
    });
  }
  if (finish.present && !finish.date && !done) {
    troubles.push({
      severity: "warning",
      code: "unparseable_finish_date",
      message: "The test finish date is present but could not be parsed.",
      suggestedFix: "Use a standard date such as 2026-06-22."
    });
  }
  if (testType === "title" && Object.keys(options).length < 2 && !done) {
    troubles.push({
      severity: "error",
      code: "missing_options",
      message: "The row needs at least two A/B options.",
      suggestedFix: "Fill at least option A and B."
    });
  }
  return troubles;
}

export function classifyStatus({ done, troubles, effectiveFinishDate, today, resultEntered, detectedOutcome }) {
  if (done) return "sheet_marked_done";
  if (resultEntered) return "result_logged";
  if (troubles.some((trouble) => trouble.severity === "error")) return "missing_data";
  if (effectiveFinishDate && effectiveFinishDate <= today) return "needs_review";
  return "running";
}

function valueAt(row, idx) {
  if (idx === null || idx === undefined || idx >= row.length) return "";
  return String(row[idx] || "").trim();
}

export function extractStudioUrl(...values) {
  const joined = values.map((value) => String(value || "")).join(" ");
  const match = joined.match(/https:\/\/studio\.youtube\.com\/video\/[A-Za-z0-9_-]{6,}\/edit[^\s"]*/);
  return match ? match[0] : "";
}

export function cleanVideoUrl(rawValue, videoId) {
  const text = String(rawValue || "");
  const match = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^ "]*v=|youtu\.be\/)[A-Za-z0-9_-]{6,}[^ "]*/);
  if (match) return match[0];
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return text.trim();
}

export function makeTestRunId({ spreadsheetId, sheetName, rowNumber, testType, videoId, startDate, finishDate, optionFingerprint }) {
  return sha1([
    spreadsheetId,
    sheetName,
    rowNumber,
    testType,
    videoId,
    startDate,
    finishDate,
    optionFingerprint
  ].join("|")).slice(0, 20);
}

export function hashStable(value) {
  return sha1(JSON.stringify(sortDeep(value)));
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value), "utf8").digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortDeep(item)])
    );
  }
  return value;
}
