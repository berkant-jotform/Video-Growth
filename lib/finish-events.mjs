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

export function parseWatcherTabs(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeWatcherTab).filter((item) => item.url);
  }
  return String(value || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, target] = line.split(/\s+\|\s+|\s+=\s+/);
      if (target) return normalizeWatcherTab({ label, target });
      return normalizeWatcherTab({ label: "", target: line });
    })
    .filter((item) => item.url);
}

export function normalizeWatcherTab(item) {
  const label = String(item?.label || item?.channel || "").trim();
  const target = String(item?.target || item?.url || item?.channelId || "").trim();
  if (!target) return { label, url: "" };
  if (/^https:\/\/studio\.youtube\.com\//i.test(target)) {
    return { label: label || target, url: target };
  }
  if (/^UC[A-Za-z0-9_-]{10,}$/i.test(target)) {
    return { label: label || target, url: `https://studio.youtube.com/channel/${target}` };
  }
  if (/^https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{10,})/i.test(target)) {
    const channelId = target.match(/\/channel\/(UC[A-Za-z0-9_-]{10,})/i)?.[1] || "";
    return { label: label || channelId, url: channelId ? `https://studio.youtube.com/channel/${channelId}` : "" };
  }
  return { label: label || target, url: "" };
}

export function parseStudioNotification(input = {}) {
  const rawText = String(input.rawText || input.text || input.title || "").trim();
  const url = String(input.url || input.href || "").trim();
  const explicitVideoId = String(input.videoId || input.video_id || "").trim();
  const videoId = explicitVideoId || extractVideoId(url, rawText);
  const channel = String(input.channel || input.channelTitle || input.channel_title || "").trim();
  const videoTitle = String(input.videoTitle || input.video_title || extractNotificationVideoTitle(rawText)).trim();
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
  if (text.length < 18 || text.length > 700) return false;
  if (
    /set a thumbnail that stands out|made for kids|coppa|age restriction|personalized ads and notifications|description i tested|running… get suggestions/i.test(
      text
    )
  ) {
    return false;
  }
  if (/^(?:a\/b|ab|thumbnail|title)?\s*test\s+(?:completed|ready)(?:\s+set\s+test)?$/i.test(text)) {
    return false;
  }
  if (/^test finished\.\s*ran from .{8,180}? to .{8,180}?\.$/i.test(text)) {
    return true;
  }
  if (/\ba\/b\s+test\s+(?:won|performed well for all|inconclusive)\b/i.test(text)) {
    return true;
  }
  if (/\bwe updated your video to use the winner\b/i.test(text)) {
    return true;
  }
  if (/\bresults? with very similar performance\b/i.test(text)) {
    return true;
  }
  if (/\btest completed with no winner\b/i.test(text)) {
    return true;
  }
  if (/\brunning\b/i.test(text) && !/\b(finished|complete|completed|ended|result|results|winner|won|selected|ready|not enough|no clear)\b/i.test(text)) {
    return false;
  }
  if (/not enough (?:impressions|data|traffic)|no clear|inconclusive/i.test(text)) return true;
  const hasTestContext = /\b(test and compare|test & compare|a\/b|ab test|experiment|thumbnail test|title test)\b/i.test(text);
  const hasFinishContext = /\b(finished|complete|completed|ended|result|results|winner|won|selected|ready)\b/i.test(text);
  return hasTestContext && hasFinishContext;
}

export function extractFinishNotificationSnippets(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const matches = [];
  const patterns = [
    /A\/B test won .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /A\/B test performed well for all .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /A\/B test inconclusive .{8,220}?(?=(?: \d+ (?:minute|hour|day|week|month)s? ago\b)| This week\b| Today\b| Yesterday\b| A\/B test (?:won|performed well for all|inconclusive)\b|$)/gi,
    /(?:Title|Thumbnail|A\/B)?\s*Test finished\.\s*Ran from .{8,220}? to .{8,220}?\./gi,
    /(?:test and compare|test & compare|thumbnail test|title test).{0,220}(?:finished|completed|ended|results? ready|no winner|similar performance)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const snippet = trimNotificationTail(match[0]);
      if (snippet && isLikelyFinishNotification(snippet)) matches.push(snippet);
    }
  }
  return Array.from(new Set(matches));
}

function extractNotificationVideoTitle(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  const current = text.match(
    /\bA\/B test (?:won|performed well for all|inconclusive)\s+(.+?)(?::\s*(?:We updated your video to use the winner|Results with very similar performance|The test completed with no winner)\b|$)/i
  );
  if (current?.[1]) return current[1].trim();
  return "";
}

function trimNotificationTail(value) {
  return String(value || "")
    .replace(/\s+\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b.*$/i, "")
    .replace(/\s+(?:Today|Yesterday|This week)\b.*$/i, "")
    .trim();
}

export function detectNotificationOutcome(rawText) {
  const text = String(rawText || "");
  if (/not enough (?:impressions|data|traffic)|no clear|inconclusive|could(?:\s+not|n't) determine/i.test(text)) {
    return "no_clear";
  }
  if (/\bperformed well for all\b|\bresults? with very similar performance\b|\btest completed with no winner\b/i.test(text)) {
    return "no_clear";
  }
  const winner =
    text.match(/(?:winner|won|winning|selected|apply|applied)[^ABC]{0,24}\b([ABC])\b/i) ||
    text.match(/\b([ABC])\b[^A-Za-z0-9]{0,24}(?:winner|won|selected|applied)/i) ||
    text.match(/option\s*([ABC])/i);
  if (winner?.[1]) return `winner_${winner[1].toLowerCase()}`;
  if (/\ba\/b\s+test\s+won\b|\bwe updated your video to use the winner\b/i.test(text)) {
    return "finished_unknown";
  }
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
      const similarity = titleSimilarity(eventTitle || eventText, candidate);
      const exactTitleMatch =
        (eventText && eventText.includes(candidate)) ||
        (eventTitle && candidate.includes(eventTitle)) ||
        (eventTitle && eventTitle.includes(candidate));
      const titleMatches =
        exactTitleMatch || similarity >= (normalizedEventChannel ? 0.7 : 0.82);
      if (!titleMatches) continue;
      const score = normalizedEventChannel ? Math.max(0.88, similarity) : Math.max(0.78, similarity);
      if (!best || score > best.score) {
        best = {
          run,
          matchedConfidence: normalizedEventChannel
            ? exactTitleMatch
              ? "title_channel"
              : "fuzzy_title_channel"
            : exactTitleMatch
              ? "title"
              : similarity >= 0.82
                ? "fuzzy_title"
                : "title",
          score
        };
      }
    }
  }

  return best || { run: null, matchedConfidence: "unmatched", score: 0 };
}

function titleSimilarity(a, b) {
  const left = significantTokens(a);
  const right = significantTokens(b);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.min(left.size, right.size);
}

function significantTokens(value) {
  return new Set(
    normalizeMatchText(value)
      .split(" ")
      .filter((token) => token.length >= 3)
      .filter((token) => !STOP_TITLE_TOKENS.has(token))
  );
}

const STOP_TITLE_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "your",
  "you",
  "how",
  "what",
  "why",
  "use",
  "using",
  "test",
  "tests",
  "result",
  "results",
  "winner",
  "similar",
  "performance",
  "completed",
  "views",
  "determine"
]);

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
        normalizeMatchText(event.rawText)
      ].join("|"),
      "utf8"
    )
    .digest("hex");
}

export function defaultConnectorChannels() {
  return TOP_CONNECTOR_CHANNELS.join(", ");
}

export function defaultWatcherTabs() {
  return TOP_CONNECTOR_CHANNELS.map((channel) => `${channel} | `).join("\n");
}
