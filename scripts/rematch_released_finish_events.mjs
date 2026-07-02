import fs from "node:fs";
import { neon } from "@neondatabase/serverless";
import {
  isLikelyFinishNotification,
  matchFinishEventToRun,
  parseStudioNotification
} from "../lib/finish-events.mjs";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const confidence = process.argv[2] || "released_false_video_id_match";
const limit = Number(process.argv[3] || 100);
const sql = neon(process.env.DATABASE_URL);

const runs = (
  await sql`
    SELECT
      test_run_id,
      video_id,
      test_type,
      channel,
      video_title,
      current_youtube_title,
      options,
      updated_at
    FROM test_runs
    WHERE status <> 'missing_data'
    ORDER BY LOWER(channel), updated_at DESC
    LIMIT 5000
  `
).map((row) => ({
  testRunId: row.test_run_id,
  videoId: row.video_id || "",
  testType: row.test_type || "",
  channel: row.channel || "",
  videoTitle: row.video_title || "",
  currentYoutubeTitle: row.current_youtube_title || "",
  options: row.options || {},
  updatedAt: row.updated_at
}));

const rows = await sql`
  SELECT event_id, video_id, channel, source, raw_text, notification_url, detected_outcome, payload, observed_at
  FROM finish_events
  WHERE processing_status = 'unmatched'
    AND matched_confidence = ${confidence}
  ORDER BY observed_at DESC
  LIMIT ${limit}
`;

const matched = [];
for (const row of rows) {
  const payload = row.payload || {};
  const event = parseStudioNotification({
    ...payload,
    source: row.source,
    rawText: row.raw_text,
    url: row.notification_url,
    videoId: row.video_id,
    channel: row.channel,
    detectedOutcome: row.detected_outcome,
    observedAt: row.observed_at
  });
  if (!isLikelyFinishNotification(event.rawText)) continue;
  const match = matchFinishEventToRun(event, runs);
  if (!match.run) continue;
  await sql`
    UPDATE finish_events
    SET test_run_id = ${match.run.testRunId},
        matched_confidence = ${`cleanup_rematch_${match.matchedConfidence}`},
        processing_status = 'matched',
        updated_at = NOW()
    WHERE event_id = ${row.event_id}
  `;
  matched.push({
    eventId: row.event_id,
    testRunId: match.run.testRunId,
    confidence: match.matchedConfidence,
    title: event.videoTitle
  });
}

const remaining = await sql`
  SELECT COUNT(*)::int AS count
  FROM finish_events
  WHERE processing_status = 'unmatched'
    AND matched_confidence = ${confidence}
`;

console.log(
  JSON.stringify(
    {
      checked: rows.length,
      matched: matched.length,
      remaining: remaining[0]?.count || 0,
      items: matched
    },
    null,
    2
  )
);

function loadLocalEnv() {
  const text = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  for (const line of text.split(/\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
