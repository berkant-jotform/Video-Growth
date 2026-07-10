import crypto from "node:crypto";
import { extractVideoId } from "./domain.mjs";
import { canonicalChannelName } from "./channels.mjs";

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
    return dedupeWatcherTabs(value.map(normalizeWatcherTab).filter((item) => item.label || item.url));
  }
  return dedupeWatcherTabs(String(value || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseWatcherTabLine)
    .filter((item) => item.label || item.url));
}

function dedupeWatcherTabs(items) {
  const result = [];
  const indexByTarget = new Map();
  for (const item of items) {
    const targetKey = watcherTargetKey(item.url);
    if (!targetKey || !indexByTarget.has(targetKey)) {
      if (targetKey) indexByTarget.set(targetKey, result.length);
      result.push(item);
      continue;
    }
    const existingIndex = indexByTarget.get(targetKey);
    if (!result[existingIndex].label && item.label) result[existingIndex] = item;
  }
  return result;
}

function watcherTargetKey(value) {
  const target = String(value || "").trim();
  if (!target) return "";
  const channelId = target.match(/(UC[A-Za-z0-9_-]{10,})/i)?.[1];
  if (channelId) return channelId.toLowerCase();
  return target.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

function parseWatcherTabLine(line) {
  const separatorIndex = String(line).search(/[|=]/);
  if (separatorIndex < 0) return normalizeWatcherTab({ label: "", target: line });
  return normalizeWatcherTab({
    label: line.slice(0, separatorIndex).trim(),
    target: line.slice(separatorIndex + 1).trim()
  });
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

export function resolveWatcherTabsFromRuns(watcherTabs = [], runs = []) {
  const channelIds = new Map();
  for (const run of runs) {
    const channel = canonicalChannelName(run?.channel || run?.youtubeChannelTitle || "");
    const channelId = String(run?.youtubeChannelId || "").trim();
    if (!channel || !channelId || channelIds.has(channel)) continue;
    channelIds.set(channel, channelId);
  }
  return watcherTabs.map((watcher) => {
    if (watcher.url) return { ...watcher, resolvedFrom: "saved" };
    const channel = canonicalChannelName(watcher.label || "");
    const channelId = channelIds.get(channel) || "";
    return {
      ...watcher,
      url: channelId ? `https://studio.youtube.com/channel/${channelId}` : "",
      resolvedFrom: channelId ? "youtube_metadata" : "unresolved"
    };
  });
}

export function parseStudioNotification(input = {}) {
  const rawText = String(input.rawText || input.text || input.title || "").trim();
  const url = String(input.url || input.href || "").trim();
  const explicitVideoId = String(input.videoId || input.video_id || "").trim();
  const videoId = explicitVideoId || extractVideoId(url, rawText);
  const channel = String(input.channel || input.channelTitle || input.channel_title || "").trim();
  const channelId = String(input.channelId || input.channel_id || "").trim();
  const videoTitle = String(input.videoTitle || input.video_title || extractNotificationVideoTitle(rawText)).trim();
  const observedAt = input.observedAt || input.observed_at || new Date().toISOString();
  const notificationAge = input.notificationAge || input.notification_age || null;
  return {
    source: input.source || "studio_bell",
    rawText,
    url,
    videoId,
    channel,
    channelId,
    videoTitle,
    notificationAge,
    detectedOutcome: detectNotificationOutcome(rawText),
    observedAt,
    occurredAt: input.occurredAt || input.occurred_at || estimateEventOccurredAt(observedAt, notificationAge)
  };
}

export function estimateEventOccurredAt(observedAt, notificationAge) {
  const observed = new Date(observedAt || Date.now());
  if (Number.isNaN(observed.valueOf())) return "";
  const parsed = parseNotificationAge(notificationAge);
  if (!parsed) return observed.toISOString();
  const occurred = new Date(observed);
  occurred.setTime(occurred.getTime() - parsed.milliseconds);
  return occurred.toISOString();
}

export function parseNotificationAge(value) {
  if (value && typeof value === "object" && Number.isFinite(Number(value.days))) {
    return { milliseconds: Number(value.days) * 86400000, label: String(value.label || "") };
  }
  const text = String(value?.label || value || "").trim();
  const match = text.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = {
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 7 * 86400000,
    month: 30 * 86400000
  }[match[2].toLowerCase()];
  return { milliseconds: amount * multiplier, label: text };
}

export function isLikelyFinishNotification(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (text.length < 18 || text.length > 700) return false;
  if (
    /set a thumbnail that stands out|made for kids|coppa|age restriction|personalized ads and notifications|description i tested|running… get suggestions|video can['’]t be monetized|claimed content found/i.test(
      text
    ) &&
    !/\ba\/b\s+test\b/i.test(text)
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
  if (/not enough (?:views|impressions|data|traffic)|no clear|inconclusive|could(?:\s+not|n't) determine/i.test(text)) return true;
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

export function expandConnectorEventInputs(events = []) {
  const expanded = [];
  for (const input of events) {
    const rawText = String(input?.rawText || input?.text || input?.title || "");
    const snippets = extractFinishNotificationSnippets(rawText);
    if (!snippets.length) {
      expanded.push(input);
      continue;
    }
    for (const snippet of snippets) {
      expanded.push({
        ...input,
        rawText: snippet,
        videoTitle: input.videoTitle || extractNotificationVideoTitle(snippet),
        notificationAge: extractNotificationAgeLabel(rawText, snippet) || input.notificationAge || input.notification_age || null,
        source: input.source || "studio_bell"
      });
    }
  }
  return dedupeExpandedEvents(expanded);
}

function dedupeExpandedEvents(events = []) {
  const map = new Map();
  for (const event of events) {
    const key = [
      event.videoId || event.video_id || "",
      event.channelId || event.channel_id || "",
      String(event.rawText || event.text || "").slice(0, 220)
    ].join("|");
    if (!map.has(key)) map.set(key, event);
  }
  return Array.from(map.values());
}

function extractNotificationAgeLabel(rawText, snippet) {
  const source = String(rawText || "").replace(/\s+/g, " ").trim();
  const target = String(snippet || "").replace(/\s+/g, " ").trim();
  const index = source.indexOf(target);
  const tail = index >= 0 ? source.slice(index + target.length, index + target.length + 140) : source;
  const match = tail.match(/\b(\d+)\s+(minute|hour|day|week|month)s?\s+ago\b/i);
  return match?.[0] || "";
}

function extractNotificationVideoTitle(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  const partial = text.match(
    /\bA\/B test (?:won|performed well for all|inconclusive)\s+(.+?)(?::\s*(?:We\b|Results?\b|The test\b|Not enough\b|No winner\b)|$)/i
  );
  if (partial?.[1]) return partial[1].trim();
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
  if (/not enough (?:views|impressions|data|traffic)|no clear|inconclusive|could(?:\s+not|n't) determine/i.test(text)) {
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
  const eventChannelId = normalizeChannelId(event.channelId);
  const eventTitle = normalizeMatchText(event.videoTitle);
  const eventText = normalizeMatchText([event.videoTitle, event.rawText].filter(Boolean).join(" "));

  if (event.videoId) {
    const exact = activeRuns.find((run) => run.videoId && run.videoId === event.videoId);
    if (exact) {
      if (eventTitle && !eventTitleMatchesRun(eventTitle, exact)) {
        return titleBasedMatch(event, activeRuns, {
          skippedVideoId: event.videoId,
          skippedRun: exact.testRunId
        });
      }
      return {
        run: exact,
        matchedConfidence: "video_id",
        score: eventChannelId && normalizeChannelId(exact.youtubeChannelId) === eventChannelId
          ? 1
          : normalizedEventChannel && normalizeMatchText(exact.channel) === normalizedEventChannel
            ? 0.98
            : 0.96
      };
    }
  }

  return titleBasedMatch(event, activeRuns);
}

function titleBasedMatch(event, activeRuns = [], context = {}) {
  const normalizedEventChannel = normalizeMatchText(event.channel);
  const eventChannelId = normalizeChannelId(event.channelId);
  const eventTitle = normalizeMatchText(event.videoTitle);
  const eventText = normalizeMatchText([event.videoTitle, event.rawText].filter(Boolean).join(" "));
  let best = null;
  for (const run of activeRuns) {
    const runChannelId = normalizeChannelId(run.youtubeChannelId);
    const channelIdMatches = Boolean(eventChannelId && runChannelId && eventChannelId === runChannelId);
    const channelIdMismatch = Boolean(eventChannelId && runChannelId && eventChannelId !== runChannelId);
    const runChannel = normalizeMatchText(run.channel);
    const channelRelation = channelMatchRelation(normalizedEventChannel, runChannel);
    const channelMatches = channelIdMatches || channelRelation === "exact" || channelRelation === "alias";
    const channelMismatch = channelIdMismatch || channelRelation === "variant";
    if (channelIdMismatch) continue;

    const titleCandidates = [
      run.videoTitle,
      run.currentYoutubeTitle,
      ...(Object.values(run.options || {}))
    ]
      .map(normalizeMatchText)
      .filter((item) => item.length >= 8);

    for (const candidate of titleCandidates) {
      const comparisonText = eventTitle || eventText;
      const similarity = titleSimilarity(comparisonText, candidate);
      const exactTitleMatch =
        (eventText && eventText.includes(candidate)) ||
        (eventTitle && candidate.includes(eventTitle)) ||
        (eventTitle && eventTitle.includes(candidate));
      const fuzzyAllowed = hasEnoughTitleTokens(comparisonText);
      const titleMatches =
        exactTitleMatch || (fuzzyAllowed && similarity >= (channelIdMatches ? 0.66 : channelMatches ? 0.7 : 0.82));
      if (!titleMatches) continue;
      if (channelMismatch && !exactTitleMatch && similarity < 0.92) continue;
      const score = channelMatches
        ? Math.max(channelIdMatches ? 0.93 : 0.88, similarity)
        : channelMismatch
          ? Math.max(0.82, similarity - 0.08)
          : Math.max(0.78, similarity);
      if (!best || score > best.score) {
        best = {
          run,
          matchedConfidence: channelMatches
            ? exactTitleMatch
              ? channelIdMatches
                ? "title_channel_id"
                : channelRelation === "alias"
                ? "title_channel_alias"
                : "title_channel"
              : channelIdMatches
                ? "fuzzy_title_channel_id"
                : channelRelation === "alias"
                ? "fuzzy_title_channel_alias"
                : "fuzzy_title_channel"
            : channelMismatch
              ? exactTitleMatch
                ? "title_channel_variant"
                : "fuzzy_title_channel_variant"
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

  if (best) {
    return context.skippedVideoId
      ? {
          ...best,
          matchedConfidence: `title_after_video_id_conflict:${best.matchedConfidence}`
        }
      : best;
  }
  return {
    run: null,
    matchedConfidence: context.skippedVideoId ? "video_id_title_conflict" : "unmatched",
    score: 0
  };
}

export function eventTitleMatchesRun(eventTitle, run) {
  const candidates = [
    run.videoTitle,
    run.currentYoutubeTitle,
    ...(Object.values(run.options || {}))
  ]
    .map(normalizeMatchText)
    .filter((item) => item.length >= 8);
  if (!candidates.length) return true;
  return candidates.some((candidate) => {
    if (eventTitle.includes(candidate) || candidate.includes(eventTitle)) return true;
    if (!hasEnoughTitleTokens(eventTitle)) return false;
    return titleSimilarity(eventTitle, candidate) >= 0.7;
  });
}

export function suggestFinishEventMatches(event, runs = [], { limit = 3 } = {}) {
  const suggestions = runs
    .map((run) => scoreFinishEventRun(event, run))
    .filter((item) => item.score >= 0.52)
    .sort((a, b) => b.score - a.score || new Date(b.run.updatedAt || 0) - new Date(a.run.updatedAt || 0))
    .slice(0, limit);

  return suggestions.map((item) => ({
    testRunId: item.run.testRunId,
    videoId: item.run.videoId || "",
    channel: item.run.channel || item.run.youtubeChannelTitle || "",
    youtubeChannelId: item.run.youtubeChannelId || "",
    testType: item.run.testType || "",
    sheetName: item.run.sheetName || "",
    rowNumber: item.run.rowNumber || 0,
    title: item.run.videoTitle || item.run.currentYoutubeTitle || item.run.videoId || "",
    confidence: item.confidence,
    score: Number(item.score.toFixed(2)),
    reason: item.reason
  }));
}

export function explainUnmatchedFinishEvent(event, suggestions = []) {
  if (event.videoId && !suggestions.length) return "No sheet row has this YouTube video ID.";
  if (suggestions.length) return "Possible sheet row found; review before accepting the match.";
  if (!event.videoId) return "Studio notification did not include a video ID, and no confident title match was found.";
  return "No matching sheet row found.";
}

function scoreFinishEventRun(event, run) {
  const normalizedEventChannel = normalizeMatchText(event.channel);
  const eventChannelId = normalizeChannelId(event.channelId);
  const runChannelId = normalizeChannelId(run.youtubeChannelId);
  const runChannel = normalizeMatchText(run.channel || run.youtubeChannelTitle);
  const channelIdMatches = Boolean(eventChannelId && runChannelId && eventChannelId === runChannelId);
  const channelIdMismatch = Boolean(eventChannelId && runChannelId && eventChannelId !== runChannelId);
  const relation = channelMatchRelation(normalizedEventChannel, runChannel);
  if (event.videoId && run.videoId === event.videoId) {
    return {
      run,
      score: channelIdMatches ? 1 : relation === "exact" ? 0.99 : relation === "alias" ? 0.97 : 0.95,
      confidence: "high",
      reason: "Matched by YouTube video ID"
    };
  }
  if (channelIdMismatch) {
    return {
      run,
      score: 0,
      confidence: "low",
      reason: "Channel ID differs"
    };
  }

  const eventTitle = normalizeMatchText(event.videoTitle);
  const eventText = normalizeMatchText([event.videoTitle, event.rawText].filter(Boolean).join(" "));
  const candidates = [
    ["sheet title", run.videoTitle],
    ["YouTube title", run.currentYoutubeTitle],
    ...Object.entries(run.options || {}).map(([key, value]) => [`option ${key}`, value])
  ]
    .map(([label, value]) => [label, normalizeMatchText(value)])
    .filter(([, value]) => value.length >= 8);

  let best = { run, score: 0, confidence: "low", reason: "No close title match" };
  for (const [label, candidate] of candidates) {
    const comparisonText = eventTitle || eventText;
    const similarity = titleSimilarity(comparisonText, candidate);
    const exactTitleMatch =
      (eventText && eventText.includes(candidate)) ||
      (eventTitle && candidate.includes(eventTitle)) ||
      (eventTitle && eventTitle.includes(candidate));
    if (!exactTitleMatch && !hasEnoughTitleTokens(comparisonText)) continue;
    let score = exactTitleMatch ? 0.9 : similarity;
    if (channelIdMatches) score += 0.14;
    else if (channelIdMismatch) score -= exactTitleMatch ? 0.08 : 0.3;
    else if (relation === "exact") score += 0.08;
    else if (relation === "alias") score += 0.05;
    else if (relation === "variant") score -= exactTitleMatch ? 0.04 : 0.15;
    else score -= 0.08;
    score = Math.max(0, Math.min(1, score));
    if (score > best.score) {
      best = {
        run,
        score,
        confidence: score >= 0.82 ? "high" : score >= 0.66 ? "medium" : "low",
        reason: exactTitleMatch
          ? relation === "alias"
            ? `Exact ${label} match; related channel name`
            : channelIdMatches
              ? `Exact ${label} match; same channel ID`
              : relation === "exact"
              ? `Exact ${label} match`
              : channelIdMismatch
                ? `Exact ${label} match; channel ID differs`
                : `Exact ${label} match; channel name differs`
          : relation === "alias"
            ? `Similar ${label}; related channel name`
            : channelIdMatches
              ? `Similar ${label}; same channel ID`
              : relation === "exact"
              ? `Similar ${label}; same channel`
              : `Similar ${label}`
      };
    }
  }
  return best;
}

function channelMatchRelation(left, right) {
  if (!left || !right) return "unknown";
  if (left === right) return "exact";
  if (channelAliasKey(left) && channelAliasKey(left) === channelAliasKey(right)) return "alias";
  return "variant";
}

function channelAliasKey(channel) {
  const normalized = normalizeMatchText(channel);
  if (["jotform apps", "apps"].includes(normalized)) return "apps";
  if (["jotform sign", "sign"].includes(normalized)) return "sign";
  if (["jotform boards", "boards"].includes(normalized)) return "boards";
  if (["jotform pdf", "jotform pdf editor", "pdf editor"].includes(normalized)) return "pdf editor";
  if (["jotform workflow", "workflow"].includes(normalized)) return "workflow";
  if (["noupe", "jotform noupe"].includes(normalized)) return "noupe";
  return normalized;
}

function normalizeChannelId(value) {
  const text = String(value || "").trim();
  return /^UC[A-Za-z0-9_-]{10,}$/.test(text) ? text : "";
}

function titleSimilarity(a, b) {
  const left = significantTokens(a);
  const right = significantTokens(b);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.min(left.size, right.size);
}

function hasEnoughTitleTokens(value, minimum = 3) {
  return significantTokens(value).size >= minimum;
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
    const option = String(record.matchedThumbnailOption || "").toUpperCase();
    if (["B", "C"].includes(option)) {
      const confidence = record.thumbnailMatchConfidence || "medium";
      return buildMetadataEvent(
        record,
        option,
        `current thumbnail visually matches option ${option} (${confidence} confidence)`
      );
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
  const occurrenceBucket = event.testRunId
    ? ""
    : String(event.occurredAt || estimateEventOccurredAt(event.observedAt, event.notificationAge) || "").slice(0, 10);
  return crypto
    .createHash("sha1")
    .update(
      [
        event.source || "",
        event.testRunId || "",
        event.videoId || "",
        event.channelId || normalizeMatchText(event.channel),
        normalizeNotificationUrl(event.url || event.notificationUrl || ""),
        occurrenceBucket,
        normalizeMatchText(event.rawText)
      ].join("|"),
      "utf8"
    )
    .digest("hex");
}

function normalizeNotificationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (!["v"].includes(key)) url.searchParams.delete(key);
    }
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

export function defaultConnectorChannels() {
  return TOP_CONNECTOR_CHANNELS.join(", ");
}

export function defaultWatcherTabs() {
  return TOP_CONNECTOR_CHANNELS.map((channel) => `${channel} | `).join("\n");
}
