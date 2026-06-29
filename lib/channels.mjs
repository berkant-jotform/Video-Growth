export const CHANNEL_PRIORITY = ["Jotform", "AI Agents Podcast", "AI Agents", "Apps", "Sign"];

export function canonicalChannelName(value) {
  const original = String(value || "").trim();
  if (!original) return "";
  const compact = normalizeChannel(stripChannelNoise(original));
  const raw = normalizeChannel(original);

  if (raw.includes("ai agents podcast") || compact.includes("ai agents podcast")) {
    return "AI Agents Podcast";
  }
  if (raw.includes("ai agents") || compact.includes("ai agents")) {
    return "AI Agents";
  }
  if (hasChannelWord(raw, "apps") || hasChannelWord(compact, "apps") || /\bjotform\s+app\b/.test(raw)) {
    return "Apps";
  }
  if (hasChannelWord(raw, "sign") || hasChannelWord(compact, "sign") || /\bjotform\s+sign\b/.test(raw)) {
    return "Sign";
  }
  if (raw.includes("jotform") || compact.includes("jotform")) {
    return "Jotform";
  }
  return stripChannelNoise(original) || original;
}

export function compareChannels(a, b) {
  const aLabel = canonicalChannelName(a);
  const bLabel = canonicalChannelName(b);
  const aRank = channelRank(aLabel);
  const bRank = channelRank(bLabel);
  if (aRank !== bRank) return aRank - bRank;
  return aLabel.localeCompare(bLabel);
}

export function channelRank(channel) {
  const normalized = normalizeChannel(canonicalChannelName(channel));
  const idx = CHANNEL_PRIORITY.findIndex((item) => normalizeChannel(item) === normalized);
  return idx >= 0 ? idx : CHANNEL_PRIORITY.length;
}

export function normalizeChannel(channel) {
  return String(channel || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripChannelNoise(value) {
  return String(value || "")
    .replace(/\b(a\/b|ab)\s+tests?\b/gi, "")
    .replace(/\b(title|titles|thumbnail|thumbnails)\b/gi, "")
    .replace(/\bchannels?\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[-_/|]+$/g, "")
    .trim();
}

function hasChannelWord(value, word) {
  return new RegExp(`(^|\\s)${word}(\\s|$)`).test(value);
}
