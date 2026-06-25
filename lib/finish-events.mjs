import crypto from "node:crypto";
import { extractVideoId } from "./domain.mjs";

export const TOP_CONNECTOR_CHANNELS = ["Jotform", "AI Agents Podcast", "AI Agents"];

export function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseConnectorChannels(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseStudioNotification(input = {}) {
  const rawText = String(input.rawText || input.text || input.title || "").trim();
  const url = String(input.url || input.href || "").trim();
  const explicitVideoId = String(input.videoId || input.video_id || "").trim();
  const videoId = explicitVideoId || extractVideoId(url, rawText);
  const channel = String(input.channel || input.channelTitle || input.channel_title || "").trim();
  const videoTitle = String(input.videoTitle || input.video_title || "").trim();
  return {
    source: input.source || "studio_bell",
    rawText,
    url,
    videoId,
    channel,
    videoTitle,
    detectedOutcome: detectNotificationOutcome(rawText),
    observedAt: input.observedAt || input.observed_at || new Date().toISOString()
  };
}

export function isLikelyFinishNotification(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (text.length < 18 || text.length > 700) return false;
  if (
    /set a thumbnail that stands out|made for kids|coppa|age restriction|personalized ads and notifications|description i tested|running… get suggestions/i.test(
      text
    )
  ) {
    return false;
  }
  if (/not enough (?:impressions|data|traffic)|no clear|inconclusive/i.test(text)) return true;
  const hasTestContext = /\b(test and compare|test & compare|a\/b|ab test|experiment|thumbnail test|title test)\b/i.test(text);
  const hasFinishContext = /\b(finished|complete|completed|ended|result|results|winner|won|selected|ready)\b/i.test(text);
  return hasTestContext && hasFinishContext;
}

export function detectNotificationOutcome(rawText) {
  const text = String(rawText || "");
  if (/not enough (?:impressions|data|traffic)|no clear|inconclusive|could(?:\s+not|n't) determine/i.test(text)) {
    return "no_clear";
  }
  const winner =
    text.match(/(?:winner|won|winning|selected|apply|applied)[^ABC]{0,24}\b([ABC])\b/i) ||
    text.match(/\b([ABC])\b[^A-Za-z0-9]{0,24}(?:winner|won|selected|applied)/i) ||
    text.match(/option\s*([ABC])/i);
  if (winner?.[1]) return `winner_${winner[1].toLowerCase()}`;
  if (/(?:test|compare|a\/b|ab test|thumbnail|title).{0,120}(?:finish|finished|complete|completed|ended|result|results)/i.test(text)) {
    return "finished_unknown";
  }
  if (/(?:finish|finished|complete|completed|ended|result|results)/i.test(text)) {
    return "finished_unknown";
  }
  return "unknown";
}

export function matchFinishEventToRun(event, activeRuns = []) {
  const normalizedEventChannel = normalizeMatchText(event.channel);
  const eventTitle = normalizeMatchText(event.videoTitle);
  const eventText = normalizeMatchText([event.videoTitle, event.rawText].filter(Boolean).join(" "));

  if (event.videoId) {
    const exact = activeRuns.find((run) => run.videoId && run.videoId === event.videoId);
    if (exact) {
      return {
        run: exact,
        matchedConfidence: "video_id",
        score: normalizedEventChannel && normalizeMatchText(exact.channel) === normalizedEventChannel ? 1 : 0.96
      };
    }
  }

  let best = null;
  for (const run of activeRuns) {
    const runChannel = normalizeMatchText(run.channel);
    if (normalizedEventChannel && runChannel && normalizedEventChannel !== runChannel) continue;

    const titleCandidates = [
      run.videoTitle,
      run.currentYoutubeTitle,
      ...(Object.values(run.options || {}))
    ]
      .map(normalizeMatchText)
      .filter((item) => item.length >= 8);

    for (const candidate of titleCandidates) {
      const titleMatches =
        (eventText && eventText.includes(candidate)) ||
        (eventTitle && candidate.includes(eventTitle)) ||
        (eventTitle && eventTitle.includes(candidate));
      if (!titleMatches) continue;
      const score = normalizedEventChannel ? 0.88 : 0.78;
      if (!best || score > best.score) {
        best = { run, matchedConfidence: normalizedEventChannel ? "title_channel" : "title", score };
      }
    }
  }

  return best || { run: null, matchedConfidence: "unmatched", score: 0 };
}

export function detectAppliedChange(record) {
  if (!record || record.status === "result_logged" || record.status === "sheet_marked_done") return null;
  if (record.testType === "title") {
    const current = normalizeMatchText(record.currentYoutubeTitle);
    if (!current) return null;
    for (const option of ["B", "C"]) {
      const optionText = normalizeMatchText(record.options?.[option]);
      if (optionText && current === optionText) {
        return buildMetadataEvent(record, option, "current title matches a non-A option");
      }
    }
  }

  if (record.testType === "thumbnail") {
    const current = String(record.currentYoutubeThumbnailUrl || "").trim();
    if (!current) return null;
    for (const option of ["B", "C"]) {
      const optionUrl = String(record.thumbnailPreviews?.[option] || "").trim();
      if (optionUrl && current === optionUrl) {
        return buildMetadataEvent(record, option, "current thumbnail matches a non-A option preview URL");
      }
    }
  }

  return null;
}

function buildMetadataEvent(record, option, reason) {
  return {
    source: "metadata",
    testRunId: record.testRunId,
    videoId: record.videoId,
    channel: record.channel,
    videoTitle: record.videoTitle || record.currentYoutubeTitle,
    rawText: `Applied change observed: option ${option}; ${reason}.`,
    url: record.studioUrl || record.videoUrl || "",
    detectedOutcome: `winner_${option.toLowerCase()}`,
    observedAt: new Date().toISOString()
  };
}

export function finishEventHash(event) {
  return crypto
    .createHash("sha1")
    .update(
      [
        event.source || "",
        event.videoId || "",
        normalizeMatchText(event.channel),
        normalizeMatchText(event.rawText),
        event.url || ""
      ].join("|"),
      "utf8"
    )
    .digest("hex");
}

export function defaultConnectorChannels() {
  return TOP_CONNECTOR_CHANNELS.join(", ");
}
