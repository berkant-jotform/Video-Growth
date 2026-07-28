#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { neon } from "@neondatabase/serverless";
import { ensureSchema } from "../lib/db.js";
import {
  buildResultMigrationPlan,
  checksum,
  migrationSnapshot,
  verifyRollbackSnapshot
} from "../lib/result-migration.mjs";

const args = new Set(process.argv.slice(2));
const applyRequested = args.has("--apply");
const rollbackRequested = args.has("--rollback");
const rehearseRequested = args.has("--rehearse");
const planPath = argumentValue("--plan");
const migrationIdArg = argumentValue("--migration-id");
const confirmation = argumentValue("--confirm");
const REHEARSAL_COPY_QUERY_COUNT = 20;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Load the production environment before running this script.");
}
if ([applyRequested, rollbackRequested, rehearseRequested].filter(Boolean).length > 1) {
  throw new Error("Choose exactly one of --apply, --rollback, or --rehearse.");
}

const sql = neon(process.env.DATABASE_URL);

if (rollbackRequested) {
  await rollbackMigration();
} else if (rehearseRequested) {
  await rehearseMigration();
} else if (applyRequested) {
  await applyMigration();
} else {
  await dryRun();
}

async function rehearseMigration() {
  const plan = await loadVerifiedPlan();
  await ensureSchema();
  const current = await loadSourceData({ canonicalColumns: true });
  const currentSnapshot = migrationSnapshot(current);
  if (checksum(currentSnapshot) !== plan.preMigrationChecksum) {
    throw new Error("Source data changed after the dry-run. Generate a new plan.");
  }
  const supportCountsBefore = await loadSupportCounts();

  const results = await sql.transaction((txn) => [
    ...rehearsalTableCopies(txn),
    txn`
      INSERT INTO result_migrations (
        migration_id, semantics_version, status, plan_checksum,
        pre_migration_checksum, summary, created_by
      ) VALUES (
        ${plan.migrationId}, ${plan.semanticsVersion}, 'applying',
        ${plan.planChecksum}, ${plan.preMigrationChecksum},
        ${JSON.stringify(plan.summary)}::jsonb, 'migration_rehearsal'
      )
    `,
    txn`
      INSERT INTO result_migration_snapshots (
        snapshot_id, migration_id, snapshot_kind, payload, checksum
      ) VALUES
        (${`snapshot_${plan.migrationId}_pre`}, ${plan.migrationId}, 'pre_migration',
          ${JSON.stringify(plan.snapshot)}::jsonb, ${plan.preMigrationChecksum}),
        (${`snapshot_${plan.migrationId}_plan`}, ${plan.migrationId}, 'migration_plan',
          ${JSON.stringify(plan)}::jsonb, ${plan.planChecksum})
    `,
    logicalTestsQuery(txn, plan.logicalTests),
    sourceUpdatesQuery(txn, plan.sourceUpdates),
    actionUpdatesQuery(txn, plan.actionUpdates),
    eventUpdatesQuery(txn, plan.eventUpdates),
    aliasesQuery(txn, plan.aliases),
    linksQuery(txn, plan.links),
    idHistoryQuery(txn, plan.idHistory),
    auditQuery(txn, plan.audit),
    txn`
      UPDATE result_migrations
      SET status = 'applied', applied_at = NOW()
      WHERE migration_id = ${plan.migrationId}
    `,
    txn`
      SELECT
        (SELECT COUNT(*)::int FROM test_runs
          WHERE result_semantics_version = ${plan.semanticsVersion}) AS run_count,
        (SELECT COUNT(*)::int FROM finish_events
          WHERE event_id IN (
            SELECT value FROM jsonb_array_elements_text(
              ${JSON.stringify(plan.eventUpdates.map((item) => item.eventId))}::jsonb
            )
          )
          AND result_semantics_version = ${plan.semanticsVersion}) AS event_count,
        (SELECT COUNT(*)::int FROM test_actions
          WHERE action_id IN (
            SELECT value FROM jsonb_array_elements_text(
              ${JSON.stringify(plan.actionUpdates.map((item) => item.actionId))}::jsonb
            )
          )
          AND test_id <> '') AS action_count
    `,
    restoreRunsQuery(txn, plan.snapshot.runs),
    restoreActionsQuery(txn, plan.snapshot.actions),
    restoreEventsQuery(txn, plan.snapshot.events),
    txn`DELETE FROM test_id_history WHERE migration_id = ${plan.migrationId}`,
    txn`DELETE FROM result_migration_audit WHERE migration_id = ${plan.migrationId}`,
    txn`
      DELETE FROM test_source_links
      WHERE test_run_id IN (
        SELECT value
        FROM jsonb_array_elements_text(
          ${JSON.stringify(plan.links.map((item) => item.testRunId))}::jsonb
        )
      )
    `,
    txn`
      DELETE FROM test_identity_aliases
      WHERE test_id IN (
        SELECT value
        FROM jsonb_array_elements_text(
          ${JSON.stringify(newlyAssignedTestIds(plan))}::jsonb
        )
      )
    `,
    txn`
      DELETE FROM logical_tests
      WHERE test_id IN (
        SELECT value
        FROM jsonb_array_elements_text(
          ${JSON.stringify(newlyAssignedTestIds(plan))}::jsonb
        )
      )
    `,
    rehearsalRunSelect(txn),
    rehearsalEventSelect(txn),
    rehearsalActionSelect(txn),
    supportCountsQuery(txn)
  ], { isolationLevel: "Serializable" });

  const appliedCounts = results[REHEARSAL_COPY_QUERY_COUNT + 11]?.[0] || {};
  const restoredSource = {
    runs: results.at(-4).map((row) => mapRun(row, true)),
    events: results.at(-3).map((row) => mapEvent(row, true)),
    actions: results.at(-2).map((row) => mapAction(row, true))
  };
  const rollback = verifyRollbackSnapshot(
    plan.snapshot,
    migrationSnapshot(restoredSource)
  );
  const supportCountsAfter = normalizeSupportCounts(results.at(-1)?.[0] || {});
  const supportExact =
    JSON.stringify(supportCountsBefore) === JSON.stringify(supportCountsAfter);
  const appliedExact =
    Number(appliedCounts.run_count || 0) === plan.sourceUpdates.length &&
    Number(appliedCounts.event_count || 0) === plan.eventUpdates.length &&
    Number(appliedCounts.action_count || 0) === plan.actionUpdates.length;

  if (!rollback.exact || !supportExact || !appliedExact) {
    throw new Error(
      `Migration rehearsal failed: rollback=${rollback.exact}, support=${supportExact}, apply=${appliedExact}`
    );
  }
  console.log(JSON.stringify({
    ok: true,
    status: "rehearsed",
    productionRowsChanged: 0,
    migrationId: plan.migrationId,
    appliedCounts,
    supportCountsBefore,
    supportCountsAfter,
    supportExact,
    appliedExact,
    ...rollback
  }, null, 2));
}

async function dryRun() {
  const source = await loadSourceData();
  const plan = buildResultMigrationPlan({
    ...source,
    migrationId: migrationIdArg || undefined
  });
  const directory = path.resolve(".local-migrations", plan.migrationId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plan.json"), JSON.stringify(plan, null, 2));
  await fs.writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      readOnly: true,
      planPath: path.join(directory, "plan.json"),
      planChecksum: plan.planChecksum,
      preMigrationChecksum: plan.preMigrationChecksum,
      summary: plan.summary,
      acceptance: acceptanceReport(plan.summary)
    }, null, 2)
  );
  printReport(plan, directory);
  if (!acceptanceReport(plan.summary).allMatched) process.exitCode = 2;
}

async function applyMigration() {
  const plan = await loadVerifiedPlan();

  await ensureSchema();
  const current = await loadSourceData({ canonicalColumns: true });
  const currentSnapshot = migrationSnapshot(current);
  if (checksum(currentSnapshot) !== plan.preMigrationChecksum) {
    throw new Error("Source data changed after the dry-run. Generate a new plan.");
  }

  await sql.transaction((txn) => [
    txn`
      INSERT INTO result_migrations (
        migration_id, semantics_version, status, plan_checksum,
        pre_migration_checksum, summary, created_by
      ) VALUES (
        ${plan.migrationId}, ${plan.semanticsVersion}, 'applying',
        ${plan.planChecksum}, ${plan.preMigrationChecksum},
        ${JSON.stringify(plan.summary)}::jsonb, ${process.env.MIGRATION_ACTOR || "migration_script"}
      )
    `,
    txn`
      INSERT INTO result_migration_snapshots (
        snapshot_id, migration_id, snapshot_kind, payload, checksum
      ) VALUES
        (${`snapshot_${plan.migrationId}_pre`}, ${plan.migrationId}, 'pre_migration',
          ${JSON.stringify(plan.snapshot)}::jsonb, ${plan.preMigrationChecksum}),
        (${`snapshot_${plan.migrationId}_plan`}, ${plan.migrationId}, 'migration_plan',
          ${JSON.stringify(plan)}::jsonb, ${plan.planChecksum})
    `,
    logicalTestsQuery(txn, plan.logicalTests),
    sourceUpdatesQuery(txn, plan.sourceUpdates),
    actionUpdatesQuery(txn, plan.actionUpdates),
    eventUpdatesQuery(txn, plan.eventUpdates),
    aliasesQuery(txn, plan.aliases),
    linksQuery(txn, plan.links),
    idHistoryQuery(txn, plan.idHistory),
    auditQuery(txn, plan.audit),
    txn`
      UPDATE result_migrations
      SET status = 'applied', applied_at = NOW()
      WHERE migration_id = ${plan.migrationId}
    `
  ], { isolationLevel: "Serializable" });

  const post = await loadSourceData({ canonicalColumns: true });
  const postChecksum = checksum(migrationSnapshot(post));
  await sql`
    UPDATE result_migrations
    SET post_migration_checksum = ${postChecksum}
    WHERE migration_id = ${plan.migrationId}
  `;
  console.log(JSON.stringify({
    ok: true,
    status: "applied",
    migrationId: plan.migrationId,
    postMigrationChecksum: postChecksum
  }, null, 2));
}

async function loadVerifiedPlan() {
  if (!planPath) throw new Error("--apply or --rehearse requires --plan <path>.");
  const plan = JSON.parse(await fs.readFile(path.resolve(planPath), "utf8"));
  if (confirmation !== plan.migrationId) {
    throw new Error(`Refusing to continue. Re-run with --confirm ${plan.migrationId}.`);
  }
  const planCore = { ...plan };
  delete planCore.planChecksum;
  delete planCore.snapshot;
  if (checksum(planCore) !== plan.planChecksum) {
    throw new Error("Plan checksum mismatch. Generate a new dry-run.");
  }
  const acceptance = acceptanceReport(plan.summary);
  if (!acceptance.allMatched) {
    throw new Error("Acceptance numbers do not match. Migration remains blocked.");
  }
  return plan;
}

async function rollbackMigration() {
  const migrationId = migrationIdArg || "";
  if (!migrationId) throw new Error("--rollback requires --migration-id <id>.");
  if (confirmation !== migrationId) {
    throw new Error(`Refusing to roll back. Re-run with --confirm ${migrationId}.`);
  }
  await ensureSchema();
  const rows = await sql`
    SELECT payload, checksum
    FROM result_migration_snapshots
    WHERE migration_id = ${migrationId}
      AND snapshot_kind = 'pre_migration'
    LIMIT 1
  `;
  const planRows = await sql`
    SELECT payload
    FROM result_migration_snapshots
    WHERE migration_id = ${migrationId}
      AND snapshot_kind = 'migration_plan'
    LIMIT 1
  `;
  if (!rows[0] || !planRows[0]) throw new Error("Migration snapshot or plan was not found.");
  const snapshot = rows[0].payload;
  const plan = planRows[0].payload;
  const newlyAssignedIds = Array.from(new Set(
    plan.logicalTests
      .map((test) => test.testId)
      .filter((testId) => !snapshot.runs.some((run) => run.testId === testId))
  ));

  await sql.transaction((txn) => [
    restoreRunsQuery(txn, snapshot.runs),
    restoreActionsQuery(txn, snapshot.actions),
    restoreEventsQuery(txn, snapshot.events),
    txn`DELETE FROM test_id_history WHERE migration_id = ${migrationId}`,
    txn`DELETE FROM result_migration_audit WHERE migration_id = ${migrationId}`,
    txn`
      DELETE FROM test_source_links
      WHERE test_run_id IN (
        SELECT value
        FROM jsonb_array_elements_text(
          ${JSON.stringify(plan.links.map((item) => item.testRunId))}::jsonb
        )
      )
    `,
    txn`
      DELETE FROM test_identity_aliases
      WHERE test_id IN (
        SELECT value
        FROM jsonb_array_elements_text(${JSON.stringify(newlyAssignedIds)}::jsonb)
      )
    `,
    txn`
      DELETE FROM logical_tests
      WHERE test_id IN (
        SELECT value
        FROM jsonb_array_elements_text(${JSON.stringify(newlyAssignedIds)}::jsonb)
      )
    `,
    txn`
      UPDATE result_migrations
      SET status = 'rolled_back', rolled_back_at = NOW()
      WHERE migration_id = ${migrationId}
    `
  ], { isolationLevel: "Serializable" });

  const restoredSource = await loadSourceData({ canonicalColumns: true });
  const restored = migrationSnapshot(restoredSource);
  const verification = verifyRollbackSnapshot(snapshot, restored);
  await sql`
    UPDATE result_migrations
    SET rollback_checksum = ${verification.restoredChecksum}
    WHERE migration_id = ${migrationId}
  `;
  if (!verification.exact) {
    throw new Error(
      `Rollback checksum mismatch: ${verification.beforeChecksum} != ${verification.restoredChecksum}`
    );
  }
  console.log(JSON.stringify({ ok: true, status: "rolled_back", migrationId, ...verification }, null, 2));
}

async function loadSourceData({ canonicalColumns = false } = {}) {
  const canonicalRunSelect = canonicalColumns
    ? `test_id, content_hash, result, result_evidence, result_semantics_version,
       explicit_winner_variant, highest_share_variant, operational_decision,
       youtube_applied_variant, inconclusive_reason, inconclusive_reason_evidence,`
    : "";
  const canonicalEventSelect = canonicalColumns
    ? `test_id, result, result_evidence, result_semantics_version,
       explicit_winner_variant, youtube_applied_variant, inconclusive_reason,
       inconclusive_reason_evidence,`
    : "";
  const canonicalActionSelect = canonicalColumns ? "test_id," : "";
  const [runRows, eventRows, actionRows] = await Promise.all([
    sql.query(`
      SELECT test_run_id, ${canonicalRunSelect}
        video_id, source_kind, spreadsheet_id, sheet_name, row_number, test_type,
        channel, video_title, start_date, finish_date, status, detected_outcome,
        suggested_winner, winner_reason, options, watch_time_share,
        current_youtube_title, youtube_channel_id, youtube_channel_title,
        option_fingerprint, updated_at
      FROM test_runs
      ORDER BY test_run_id
    `),
    sql.query(`
      SELECT event_id, ${canonicalEventSelect}
        test_run_id, video_id, channel_id, channel, source, raw_text,
        detected_outcome, processing_status, payload, occurred_at, observed_at
      FROM finish_events
      ORDER BY event_id
    `),
    sql.query(`
      SELECT action_id, ${canonicalActionSelect}
        test_run_id, action, actor_name, created_at, undone_at
      FROM test_actions
      ORDER BY action_id
    `)
  ]);
  return {
    runs: runRows.map((row) => mapRun(row, canonicalColumns)),
    events: eventRows.map((row) => mapEvent(row, canonicalColumns)),
    actions: actionRows.map((row) => mapAction(row, canonicalColumns))
  };
}

async function loadSupportCounts() {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM logical_tests) AS logical_tests,
      (SELECT COUNT(*)::int FROM test_identity_aliases) AS aliases,
      (SELECT COUNT(*)::int FROM test_source_links) AS links,
      (SELECT COUNT(*)::int FROM test_id_history) AS id_history,
      (SELECT COUNT(*)::int FROM result_migration_audit) AS migration_audit
  `;
  return normalizeSupportCounts(rows[0] || {});
}

function mapRun(row, canonicalColumns) {
  const semanticsApplied = canonicalColumns && Boolean(row.result_semantics_version);
  return {
    testRunId: row.test_run_id,
    testId: semanticsApplied ? row.test_id || "" : "",
    contentHash: semanticsApplied ? row.content_hash || "" : "",
    videoId: row.video_id,
    sourceKind: row.source_kind,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    rowNumber: row.row_number,
    testType: row.test_type,
    channel: row.channel,
    videoTitle: row.video_title,
    startDate: dateOnly(row.start_date),
    finishDate: dateOnly(row.finish_date),
    status: row.status,
    detectedOutcome: row.detected_outcome,
    suggestedWinner: row.suggested_winner,
    winnerReason: row.winner_reason,
    options: jsonValue(row.options, {}),
    watchTimeShare: jsonValue(row.watch_time_share, {}),
    currentYoutubeTitle: row.current_youtube_title,
    youtubeChannelId: row.youtube_channel_id,
    youtubeChannelTitle: row.youtube_channel_title,
    optionFingerprint: row.option_fingerprint,
    updatedAt: row.updated_at,
    result: semanticsApplied ? row.result : "",
    resultEvidence: semanticsApplied ? row.result_evidence : "",
    resultSemanticsVersion: semanticsApplied ? row.result_semantics_version : "",
    explicitWinnerVariant: semanticsApplied ? row.explicit_winner_variant : "",
    highestShareVariant: semanticsApplied ? row.highest_share_variant : "",
    operationalDecision: semanticsApplied ? row.operational_decision : "",
    youtubeAppliedVariant: semanticsApplied ? row.youtube_applied_variant : "",
    inconclusiveReason: semanticsApplied ? row.inconclusive_reason : "",
    inconclusiveReasonEvidence: semanticsApplied ? row.inconclusive_reason_evidence : ""
  };
}

function mapEvent(row, canonicalColumns) {
  const semanticsApplied = canonicalColumns && Boolean(row.result_semantics_version);
  return {
    eventId: row.event_id,
    testId: semanticsApplied ? row.test_id || "" : "",
    testRunId: row.test_run_id,
    videoId: row.video_id,
    channelId: row.channel_id,
    channel: row.channel,
    source: row.source,
    rawText: row.raw_text,
    detectedOutcome: row.detected_outcome,
    processingStatus: row.processing_status,
    payload: jsonValue(row.payload, {}),
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    result: semanticsApplied ? row.result : "",
    resultEvidence: semanticsApplied ? row.result_evidence : "",
    resultSemanticsVersion: semanticsApplied ? row.result_semantics_version : "",
    explicitWinnerVariant: semanticsApplied ? row.explicit_winner_variant : "",
    youtubeAppliedVariant: semanticsApplied ? row.youtube_applied_variant : "",
    inconclusiveReason: semanticsApplied ? row.inconclusive_reason : "",
    inconclusiveReasonEvidence: semanticsApplied ? row.inconclusive_reason_evidence : ""
  };
}

function mapAction(row, canonicalColumns) {
  return {
    actionId: row.action_id,
    testId: canonicalColumns ? row.test_id || "" : "",
    testRunId: row.test_run_id,
    action: row.action,
    actorName: row.actor_name,
    createdAt: row.created_at,
    undoneAt: row.undone_at
  };
}

function logicalTestsQuery(txn, rows) {
  return txn`
    INSERT INTO logical_tests (
      test_id, primary_test_run_id, video_id, test_type, source_kind,
      lifecycle_status, data_quality_flag, result, result_evidence,
      result_semantics_version, explicit_winner_variant, highest_share_variant,
      operational_decision, youtube_applied_variant, inconclusive_reason,
      inconclusive_reason_evidence, content_hash
    )
    SELECT
      item->>'testId', item->>'primaryTestRunId', item->>'videoId',
      item->>'testType', item->>'sourceKind', item->>'lifecycleStatus',
      item->>'dataQualityFlag', item->>'result', item->>'resultEvidence',
      item->>'resultSemanticsVersion', item->>'explicitWinnerVariant',
      item->>'highestShareVariant', item->>'operationalDecision',
      item->>'youtubeAppliedVariant', item->>'inconclusiveReason',
      item->>'inconclusiveReasonEvidence', item->>'contentHash'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    ON CONFLICT (test_id) DO NOTHING
  `;
}

function sourceUpdatesQuery(txn, rows) {
  return txn`
    UPDATE test_runs tr
    SET test_id = item->>'testId',
        content_hash = item->>'contentHash',
        result = item->>'result',
        result_evidence = item->>'resultEvidence',
        result_semantics_version = item->>'resultSemanticsVersion',
        explicit_winner_variant = item->>'explicitWinnerVariant',
        highest_share_variant = item->>'highestShareVariant',
        operational_decision = item->>'operationalDecision',
        youtube_applied_variant = item->>'youtubeAppliedVariant',
        inconclusive_reason = item->>'inconclusiveReason',
        inconclusive_reason_evidence = item->>'inconclusiveReasonEvidence'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE tr.test_run_id = item->>'testRunId'
  `;
}

function actionUpdatesQuery(txn, rows) {
  return txn`
    UPDATE test_actions ta
    SET test_id = item->>'testId'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE ta.action_id = item->>'actionId'
  `;
}

function eventUpdatesQuery(txn, rows) {
  return txn`
    UPDATE finish_events fe
    SET test_id = item->>'testId',
        result = item->>'result',
        result_evidence = item->>'resultEvidence',
        result_semantics_version = item->>'resultSemanticsVersion',
        explicit_winner_variant = item->>'explicitWinnerVariant',
        youtube_applied_variant = item->>'youtubeAppliedVariant',
        inconclusive_reason = item->>'inconclusiveReason',
        inconclusive_reason_evidence = item->>'inconclusiveReasonEvidence'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE fe.event_id = item->>'eventId'
  `;
}

function aliasesQuery(txn, rows) {
  return txn`
    INSERT INTO test_identity_aliases (
      alias_id, test_id, alias_type, alias_value
    )
    SELECT item->>'aliasId', item->>'testId', item->>'aliasType', item->>'aliasValue'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    ON CONFLICT (alias_value) DO NOTHING
  `;
}

function linksQuery(txn, rows) {
  return txn`
    INSERT INTO test_source_links (
      test_run_id, test_id, linkage_method, linkage_confidence
    )
    SELECT item->>'testRunId', item->>'testId', item->>'linkageMethod', item->>'linkageConfidence'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    ON CONFLICT (test_run_id) DO NOTHING
  `;
}

function idHistoryQuery(txn, rows) {
  return txn`
    INSERT INTO test_id_history (
      history_id, test_id, test_run_id, event_type, old_value, new_value,
      reason, migration_id
    )
    SELECT
      item->>'historyId', item->>'testId', item->>'testRunId',
      item->>'eventType', item->'oldValue', item->'newValue',
      item->>'reason', item->>'migrationId'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    ON CONFLICT (history_id) DO NOTHING
  `;
}

function auditQuery(txn, rows) {
  return txn`
    INSERT INTO result_migration_audit (
      audit_id, migration_id, test_id, test_run_id, field_name,
      old_value, new_value, evidence, reason, semantics_version
    )
    SELECT
      item->>'auditId', item->>'migrationId', item->>'testId',
      item->>'testRunId', item->>'fieldName',
      COALESCE(item->'oldValue', 'null'::jsonb),
      COALESCE(item->'newValue', 'null'::jsonb),
      item->>'evidence', item->>'reason', item->>'semanticsVersion'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    ON CONFLICT (audit_id) DO NOTHING
  `;
}

function restoreRunsQuery(txn, rows) {
  return txn`
    UPDATE test_runs tr
    SET test_id = NULLIF(item->>'testId', ''),
        content_hash = item->>'contentHash',
        result = COALESCE(NULLIF(item->>'result', ''), 'unknown'),
        result_evidence = COALESCE(NULLIF(item->>'resultEvidence', ''), 'unknown'),
        result_semantics_version = item->>'resultSemanticsVersion',
        explicit_winner_variant = item->>'explicitWinnerVariant',
        highest_share_variant = item->>'highestShareVariant',
        operational_decision = item->>'operationalDecision',
        youtube_applied_variant = item->>'youtubeAppliedVariant',
        inconclusive_reason = item->>'inconclusiveReason',
        inconclusive_reason_evidence = item->>'inconclusiveReasonEvidence'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE tr.test_run_id = item->>'testRunId'
  `;
}

function restoreActionsQuery(txn, rows) {
  return txn`
    UPDATE test_actions ta
    SET test_id = NULLIF(item->>'testId', '')
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE ta.action_id = item->>'actionId'
  `;
}

function restoreEventsQuery(txn, rows) {
  return txn`
    UPDATE finish_events fe
    SET test_id = NULLIF(item->>'testId', ''),
        result = COALESCE(NULLIF(item->>'result', ''), 'unknown'),
        result_evidence = COALESCE(NULLIF(item->>'resultEvidence', ''), 'unknown'),
        result_semantics_version = item->>'resultSemanticsVersion',
        explicit_winner_variant = item->>'explicitWinnerVariant',
        youtube_applied_variant = item->>'youtubeAppliedVariant',
        inconclusive_reason = item->>'inconclusiveReason',
        inconclusive_reason_evidence = item->>'inconclusiveReasonEvidence'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) item
    WHERE fe.event_id = item->>'eventId'
  `;
}

function rehearsalTableCopies(txn) {
  return [
    txn`CREATE TEMP TABLE test_runs (LIKE public.test_runs INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO test_runs SELECT * FROM public.test_runs`,
    txn`CREATE TEMP TABLE test_actions (LIKE public.test_actions INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO test_actions SELECT * FROM public.test_actions`,
    txn`CREATE TEMP TABLE finish_events (LIKE public.finish_events INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO finish_events SELECT * FROM public.finish_events`,
    txn`CREATE TEMP TABLE logical_tests (LIKE public.logical_tests INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO logical_tests SELECT * FROM public.logical_tests`,
    txn`CREATE TEMP TABLE test_identity_aliases (LIKE public.test_identity_aliases INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO test_identity_aliases SELECT * FROM public.test_identity_aliases`,
    txn`CREATE TEMP TABLE test_source_links (LIKE public.test_source_links INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO test_source_links SELECT * FROM public.test_source_links`,
    txn`CREATE TEMP TABLE test_id_history (LIKE public.test_id_history INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO test_id_history SELECT * FROM public.test_id_history`,
    txn`CREATE TEMP TABLE result_migrations (LIKE public.result_migrations INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO result_migrations SELECT * FROM public.result_migrations`,
    txn`CREATE TEMP TABLE result_migration_snapshots (LIKE public.result_migration_snapshots INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO result_migration_snapshots SELECT * FROM public.result_migration_snapshots`,
    txn`CREATE TEMP TABLE result_migration_audit (LIKE public.result_migration_audit INCLUDING ALL) ON COMMIT DROP`,
    txn`INSERT INTO result_migration_audit SELECT * FROM public.result_migration_audit`
  ];
}

function rehearsalRunSelect(txn) {
  return txn`
    SELECT
      test_run_id, test_id, content_hash, result, result_evidence,
      result_semantics_version, explicit_winner_variant, highest_share_variant,
      operational_decision, youtube_applied_variant, inconclusive_reason,
      inconclusive_reason_evidence
    FROM test_runs
    ORDER BY test_run_id
  `;
}

function rehearsalEventSelect(txn) {
  return txn`
    SELECT
      event_id, test_id, result, result_evidence, result_semantics_version,
      explicit_winner_variant, youtube_applied_variant, inconclusive_reason,
      inconclusive_reason_evidence
    FROM finish_events
    ORDER BY event_id
  `;
}

function rehearsalActionSelect(txn) {
  return txn`
    SELECT action_id, test_id
    FROM test_actions
    ORDER BY action_id
  `;
}

function supportCountsQuery(txn) {
  return txn`
    SELECT
      (SELECT COUNT(*)::int FROM logical_tests) AS logical_tests,
      (SELECT COUNT(*)::int FROM test_identity_aliases) AS aliases,
      (SELECT COUNT(*)::int FROM test_source_links) AS links,
      (SELECT COUNT(*)::int FROM test_id_history) AS id_history,
      (SELECT COUNT(*)::int FROM result_migration_audit) AS migration_audit
  `;
}

function normalizeSupportCounts(row) {
  return {
    logicalTests: Number(row.logical_tests || 0),
    aliases: Number(row.aliases || 0),
    links: Number(row.links || 0),
    idHistory: Number(row.id_history || 0),
    migrationAudit: Number(row.migration_audit || 0)
  };
}

function newlyAssignedTestIds(plan) {
  return Array.from(new Set(
    plan.logicalTests
      .map((test) => test.testId)
      .filter((testId) => !plan.snapshot.runs.some((run) => run.testId === testId))
  ));
}

function acceptanceReport(summary) {
  const expected = {
    logicalTestCount: 1275,
    terminalTestCount: 882,
    resultEvidenceCount: 446,
    sharesPresentCount: 453,
    strictSharesCount: 362,
    missingStartAndFinishCount: 115,
    missingFinishCount: 278,
    nonTerminalTestCount: 393,
    nonTerminalWithUsableStartCount: 278,
    legacyWinnerRows: 0,
    resultDistribution: {
      "unknown|unknown": 829,
      "inconclusive|sheet_explicit": 295,
      "performed_same|studio_explicit": 76,
      "inconclusive|studio_explicit": 71,
      "winner|studio_explicit": 4
    }
  };
  const checks = Object.fromEntries(
    Object.entries(expected)
      .filter(([key]) => key !== "resultDistribution")
      .map(([key, value]) => [key, {
        expected: value,
        actual: summary[key],
        matched: summary[key] === value
      }])
  );
  checks.resultDistribution = {
    expected: expected.resultDistribution,
    actual: summary.resultDistribution,
    matched:
      Object.keys(expected.resultDistribution).length ===
        Object.keys(summary.resultDistribution || {}).length &&
      Object.entries(expected.resultDistribution).every(
        ([key, value]) => summary.resultDistribution?.[key] === value
      )
  };
  return {
    allMatched: Object.values(checks).every((check) => check.matched),
    checks
  };
}

function printReport(plan, directory) {
  console.log(JSON.stringify({
    mode: "dry-run",
    wroteDatabase: false,
    migrationId: plan.migrationId,
    planPath: path.join(directory, "plan.json"),
    planChecksum: plan.planChecksum,
    preMigrationChecksum: plan.preMigrationChecksum,
    summary: plan.summary,
    acceptance: acceptanceReport(plan.summary)
  }, null, 2));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString().slice(0, 10);
}
