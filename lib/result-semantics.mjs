export const RESULT_SEMANTICS_VERSION = "2.0";

export const RESULT_VALUES = Object.freeze([
  "winner",
  "performed_same",
  "inconclusive",
  "cancelled",
  "running",
  "unknown"
]);

export const RESULT_EVIDENCE_VALUES = Object.freeze([
  "studio_explicit",
  "sheet_explicit",
  "inferred_legacy",
  "unknown"
]);

const INSUFFICIENT_RE =
  /not enough (?:views|impressions|data|traffic)|insufficient (?:views|impressions|data|traffic)/i;
const NO_WINNER_RE =
  /no (?:clear )?winner|inconclusive|could(?:\s+not|n't) determine|test completed with no winner/i;
const PERFORMED_SAME_RE =
  /performed well for all|results? with very similar performance|very similar performance/i;
const STUDIO_WINNER_RE =
  /\ba\/b\s+test\s+won\b|\bwe updated your video to use the winner\b/i;

export function classifyStudioResult(rawText = "") {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return unknownResult();
  const explicitWinnerVariant = extractExplicitWinnerVariant(text);

  if (
    STUDIO_WINNER_RE.test(text) ||
    (
      explicitWinnerVariant &&
      /\b(?:test|a\/b|thumbnail|title)\b/i.test(text) &&
      /\b(?:winner|won|winning|selected|applied)\b/i.test(text)
    )
  ) {
    return {
      ...unknownResult(),
      result: "winner",
      resultEvidence: "studio_explicit",
      explicitWinnerVariant
    };
  }

  if (PERFORMED_SAME_RE.test(text)) {
    return {
      ...unknownResult(),
      result: "performed_same",
      resultEvidence: "studio_explicit"
    };
  }

  if (INSUFFICIENT_RE.test(text) || NO_WINNER_RE.test(text)) {
    return {
      ...unknownResult(),
      result: "inconclusive",
      resultEvidence: "studio_explicit",
      inconclusiveReason: INSUFFICIENT_RE.test(text) ? "insufficient_views" : "",
      inconclusiveReasonEvidence: INSUFFICIENT_RE.test(text) ? "studio_explicit" : ""
    };
  }

  return unknownResult();
}

export function classifySheetResult({ shares = {}, rawValues = [] } = {}) {
  const shareWinner = Object.entries(shares || {}).find(
    ([variant, value]) =>
      ["A", "B", "C"].includes(normalizeVariant(variant)) &&
      typeof value === "string" &&
      /^(?:winner|won|selected|applied)$/i.test(value.trim())
  );
  const rawText = [
    ...Object.values(shares || {}).filter((value) => typeof value === "string"),
    ...(rawValues || [])
  ]
    .map(String)
    .join(" ");
  const explicitWinnerVariant =
    normalizeVariant(shareWinner?.[0]) || extractExplicitWinnerVariant(rawText);

  if (
    explicitWinnerVariant &&
    /\b(?:winner|won|winning|selected|applied)\b/i.test(rawText)
  ) {
    return {
      ...unknownResult(),
      result: "winner",
      resultEvidence: "sheet_explicit",
      explicitWinnerVariant
    };
  }

  if (PERFORMED_SAME_RE.test(rawText)) {
    return {
      ...unknownResult(),
      result: "performed_same",
      resultEvidence: "sheet_explicit"
    };
  }

  if (
    Object.values(shares || {}).some((value) => value === "no_clear_winner") ||
    INSUFFICIENT_RE.test(rawText) ||
    NO_WINNER_RE.test(rawText)
  ) {
    return {
      ...unknownResult(),
      result: "inconclusive",
      resultEvidence: "sheet_explicit",
      inconclusiveReason: INSUFFICIENT_RE.test(rawText) ? "insufficient_views" : "",
      inconclusiveReasonEvidence: INSUFFICIENT_RE.test(rawText) ? "sheet_explicit" : ""
    };
  }

  return unknownResult();
}

export function analyzeShares({ shares = {}, options = {} } = {}) {
  const configuredVariants = ["A", "B", "C"].filter((variant) =>
    hasConfiguredOption(options?.[variant])
  );
  const allNumericEntries = Object.entries(shares || {}).filter(
    ([variant, value]) =>
      ["A", "B", "C"].includes(normalizeVariant(variant)) && Number.isFinite(value)
  );
  const configuredNumericEntries = allNumericEntries.filter(
    ([variant, value]) => configuredVariants.includes(variant) && Number.isFinite(value)
  );
  const complete =
    configuredVariants.length >= 2 &&
    configuredNumericEntries.length === configuredVariants.length;
  const shareSum = complete
    ? configuredNumericEntries.reduce((total, [, value]) => total + Number(value), 0)
    : null;
  const shareSumValid =
    complete &&
    Number.isFinite(shareSum) &&
    Math.abs(shareSum - 1) <= 0.01;

  let highestShareVariant = "";
  if (allNumericEntries.length) {
    const sorted = [...allNumericEntries].sort((left, right) => right[1] - left[1]);
    const tied =
      sorted.length > 1 &&
      Math.abs(Number(sorted[0][1]) - Number(sorted[1][1])) < 0.000001;
    if (!tied) highestShareVariant = sorted[0][0];
  }

  return {
    configuredVariantCount: configuredVariants.length,
    populatedShareCount: allNumericEntries.length,
    shareSum,
    shareSumValid,
    highestShareVariant,
    quality:
      configuredVariants.length < 2
        ? "configured_variants_unknown"
        : !complete
          ? "incomplete"
          : shareSumValid
            ? "valid"
            : "invalid_sum"
  };
}

export function projectCanonicalResult({
  result = "",
  resultEvidence = "",
  resultSemanticsVersion = "",
  explicitWinnerVariant = "",
  inconclusiveReason = "",
  inconclusiveReasonEvidence = "",
  detectedOutcome = "",
  suggestedWinner = "",
  winnerReason = "",
  finishEventText = "",
  finishEventOutcome = "",
  finishEventSource = "",
  shares = {},
  options = {}
} = {}) {
  if (RESULT_VALUES.includes(result) && resultSemanticsVersion) {
    return {
      result,
      resultEvidence: RESULT_EVIDENCE_VALUES.includes(resultEvidence) ? resultEvidence : "unknown",
      resultSemanticsVersion,
      explicitWinnerVariant: normalizeVariant(explicitWinnerVariant),
      inconclusiveReason: String(inconclusiveReason || ""),
      inconclusiveReasonEvidence: String(inconclusiveReasonEvidence || ""),
      ...analyzeShares({ shares, options })
    };
  }

  const studio =
    finishEventSource === "metadata"
      ? classifyStudioResult("")
      : classifyStudioResult(finishEventText);
  if (studio.result !== "unknown") {
    return {
      ...studio,
      ...analyzeShares({ shares, options })
    };
  }

  const sheet = classifySheetResult({ shares });
  if (sheet.result !== "unknown") {
    return {
      ...sheet,
      ...analyzeShares({ shares, options })
    };
  }

  if (finishEventSource === "metadata") {
    return {
      ...unknownResult(),
      ...analyzeShares({ shares, options })
    };
  }

  const legacyOutcome = String(finishEventOutcome || detectedOutcome || "").toLowerCase();
  const descriptiveShares = analyzeShares({ shares, options });
  const legacyWasShareInference =
    /^winner_[abc]$/.test(legacyOutcome) &&
    /highest watch-time share/i.test(String(winnerReason || ""));

  if (/^winner_[abc]$/.test(legacyOutcome) && !legacyWasShareInference) {
    return {
      ...unknownResult(),
      result: "winner",
      resultEvidence: "inferred_legacy",
      explicitWinnerVariant: normalizeVariant(
        legacyOutcome.slice(-1) || suggestedWinner
      ),
      ...descriptiveShares
    };
  }

  if (legacyOutcome === "no_clear") {
    return {
      ...unknownResult(),
      result: "inconclusive",
      resultEvidence: "inferred_legacy",
      ...descriptiveShares
    };
  }

  return {
    ...unknownResult(),
    ...descriptiveShares
  };
}

export function resultDisplayLabel(result = "") {
  return {
    winner: "YouTube winner",
    performed_same: "Performed similarly",
    inconclusive: "Inconclusive",
    cancelled: "Cancelled",
    running: "Running",
    unknown: "Result unknown"
  }[result] || "Result unknown";
}

export function highestShareDescription(variant = "") {
  const normalized = normalizeVariant(variant);
  return normalized
    ? `Highest share ${normalized} · descriptive, not a YouTube result`
    : "";
}

function extractExplicitWinnerVariant(text) {
  const winner =
    text.match(/\boption\s*([ABC])\b/i) ||
    text.match(/\b(?:winner|winning option|selected option|applied option)\s*(?:is|:|-)?\s*([ABC])\b/i) ||
    text.match(/\bvariant\s*([ABC])\b/i) ||
    text.match(/\b([ABC])\s+(?:won|is the winner|was selected|was applied)\b/i);
  return normalizeVariant(winner?.[1]);
}

function normalizeVariant(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return ["A", "B", "C"].includes(normalized) ? normalized : "";
}

function hasConfiguredOption(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim() !== "";
}

function unknownResult() {
  return {
    result: "unknown",
    resultEvidence: "unknown",
    resultSemanticsVersion: RESULT_SEMANTICS_VERSION,
    explicitWinnerVariant: "",
    inconclusiveReason: "",
    inconclusiveReasonEvidence: ""
  };
}
