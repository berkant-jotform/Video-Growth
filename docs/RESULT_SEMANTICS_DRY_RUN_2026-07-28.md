# Result Semantics Migration Dry-Run

Status: **APPLIED AND VERIFIED IN PRODUCTION**

Generated from the live production database on 2026-07-28 using the read-only
mode of `scripts/result-semantics-migration.mjs`.

## Plan Identity

- Migration ID: `result_semantics_20260728102828`
- Plan checksum: `3d4e4afe779326ea5fb6ba40057f93e93e16ad1f238de339c39f141d0d90fdef`
- Pre-migration checksum: `d19c61fe62883aa4ff3a9dbd9b27fff0b0078fa97921849dd2c8d88db1939dac`
- Local plan: `.local-migrations/result_semantics_20260728102828/plan.json`
- Production application: **complete**

The local plan is intentionally ignored by Git because it contains a complete
snapshot of internal records. The migration was applied only after the dry-run,
snapshot, and rollback rehearsal passed.

## Source Reconciliation

| Population | Actual |
| --- | ---: |
| Raw database records | 1,946 |
| Sheet-source records | 1,892 |
| App-managed source records | 54 |
| Logical sheet tests | 1,275 |
| App-managed logical tests | 29 |

## Post-Repair Result Distribution

| Result | Evidence | Expected | Actual | Match |
| --- | --- | ---: | ---: | --- |
| Unknown | Unknown | 829 | 829 | Yes |
| Inconclusive | Sheet explicit | 295 | 295 | Yes |
| Performed similarly | Studio explicit | 76 | 76 | Yes |
| Inconclusive | Studio explicit | 71 | 71 | Yes |
| Winner | Studio explicit | 4 | 4 | Yes |

`result=winner AND result_evidence=inferred_legacy` returns **0** tests after
the applied repair.

## Applied Migration

- Raw test-run updates: **1,946**
- Finish-event updates: **983**
- Reviewer actions linked to persisted logical tests: **104**
- Production result distribution: **4 winner / 76 performed_same /
  366 inconclusive / 829 unknown = 1,275**
- Lifecycle distribution: **882 finished / 278 unknown with
  missing_finish_evidence / 115 unknown with
  missing_start_and_finish_evidence**

The 1,946 updates are raw records, while the acceptance distribution is one row
per persisted logical sheet test. The rollup is:

| Result | Raw records updated | Logical sheet tests |
| --- | ---: | ---: |
| Winner | 8 | 4 |
| Performed similarly | 139 | 76 |
| Inconclusive | 524 | 366 |
| Unknown | 1,221 | 829 |
| Total | 1,892 sheet records | 1,275 sheet tests |

The remaining **54 raw records** roll up to **29 app-managed logical tests**.
They are exported as a separate grain and are not part of the 1,275-test
migration acceptance distribution.

## Coverage

The earlier 891 denominator is stale. No defensible evidence rule produces it.
The strict terminal-evidence population is 882 and is retained as one reporting
denominator, not frozen as the final coverage denominator. Phase E also shows
the wider denominator of 882 plus non-terminal tests whose stored start date is
at least 21 days before the export's as-of date.

| Metric | Expected | Actual | Actual coverage | Match |
| --- | ---: | ---: | ---: | --- |
| Terminal tests | 891 | 882 | - | No |
| Explicit result evidence | 446 | 446 | 50.6% of 882 | Yes count |
| Shares present | 453 raw rows | 364 logical tests | 41.3% of 882 | Grain corrected |
| Strictly validated shares | 362 | 362 | 41.0% of 882 | Yes count |

The 393 non-terminal logical tests contain:

- 278 tests with a usable start date but no terminal evidence.
- 115 tests with neither terminal evidence nor a usable start date.
- 13 tests with a reviewer A decision but no independent terminal evidence.

The earlier plan incorrectly described the whole non-terminal population as
missing start dates. The migration now records two separate flags while keeping
both groups at `lifecycle_status=unknown`, `result=unknown`:

- `missing_finish_evidence`: 278
- `missing_start_and_finish_evidence`: 115

Reviewer choices remain `operational_decision` only. Counting all 13 as
terminal would produce 895, not 891. Selecting nine of those thirteen would
match the expected denominator, but there is no documented evidence rule that
supports that choice. The migration did not invent a terminal state for any of
these tests.

## Visible Result Changes

| Dashboard result concept | Before | After |
| --- | ---: | ---: |
| Share-derived winner labels | 453 | 0 |
| Explicit YouTube Winner results | Not trustworthy | 4 |
| Performed similarly results | Merged into legacy no-clear | 76 |
| Inconclusive results | Merged into legacy no-clear | 366 |
| Unknown results | Underreported | 829 |
| Descriptive highest-share values | 0 explicit labels | 453 |

Queue workflow statuses remain operational states. Numeric shares still make a
row eligible for result-entry workflow, but they never create a YouTube Winner.

## Safety Gates

- Google Sheets and YouTube remain read-only.
- The dry-run did not call schema initialization or write to the database.
- Applying requires the exact migration ID, plan checksum, unchanged source
  checksum, and a fully passing acceptance report.
- The apply path uses one serializable transaction with a pre-migration
  snapshot and append-only field audit.
- Rollback is keyed by migration ID and verifies the restored snapshot checksum.
- Production apply required the unchanged source checksum and exact approved
  migration identity.

## Denominator Decision

The migration is not blocked by the denominator. It reports how many of the 278
started tests have a stored start date at least 21 days old and publishes
coverage under:

1. Strict terminal evidence: 882.
2. Strict terminal evidence plus the `stored_start_age_days >= 21` group.

Phase E computes coverage bands from the selected denominator. It does not
hardcode the expected band.

As of 2026-07-28, **247** of the 278 started tests are 21 days old or older.
The rule is `stored_start_age_days >= 21`. It is a reporting definition, not a
measured finish event, and does not promote those tests or gate the migration.

| Metric | Strict terminal evidence (882) | Terminal + over-three-weeks (1,129) |
| --- | ---: | ---: |
| Explicit result evidence | 446 (50.6%) | 446 (39.5%) |
| Shares present | 364 (41.3%) | 364 (32.2%) |
| Strictly validated shares | 362 (41.0%) | 362 (32.1%) |

## Rollback Rehearsal

The apply and rollback queries were executed against temporary database copies
before the production run:

- Test-run updates applied: 1,946
- Finish-event updates applied: 983
- Action links applied: 104
- Support-table counts before and after rollback: exact
- Restored checksum:
  `d19c61fe62883aa4ff3a9dbd9b27fff0b0078fa97921849dd2c8d88db1939dac`
- Production rows changed by rehearsal: 0

## Reviewer Action Count

The earlier audit saw **102** reviewer actions. The migration linked **104**
because two new BG actions were recorded after that audit, at 2026-07-28
06:50:44 UTC and 06:58:11 UTC. This is new activity, not a grain mismatch.
