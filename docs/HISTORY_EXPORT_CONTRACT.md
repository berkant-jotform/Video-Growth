# History Export Contract

Status: **IMPLEMENTED IN 5.0.0, FEATURE FLAG OFF BY DEFAULT**

## Purpose

History export provides an analysis-ready workbook and an optional audit
package without writing to Google Sheets or YouTube. The export uses persisted
logical test identities and never infers a YouTube Winner from the highest
watch-time share.

## Identity And Grains

| Dataset | Grain | Production verification |
| --- | --- | ---: |
| Tests | One row per persisted `test_id` | 1,304 |
| Sheet-backed Tests | One row per logical title/thumbnail test | 1,275 |
| App-managed Tests | One row per Studio-only logical test | 29 |
| Source Records | One row per raw `test_run_id` | 1,946 |
| Variants | One row per configured A/B/C option | 2,066 |
| Actions | One row per reviewer action, including undone actions | 104 |
| Finish Signals | One row per persisted finish event | 983 |
| Video Context | One row per YouTube `video_id` returned by the API | 767 in QA |

`test_id` joins Tests to Variants and Actions. `video_id` joins Tests to Video
Context. A video can have multiple tests. `content_hash`, titles, dates, and
option fingerprints are matching evidence, not identity.

The 1,946 raw-record migration rollup to the 1,275 logical sheet-test
distribution is:

- 8 winner records -> 4 logical winners
- 139 performed-same records -> 76 logical performed-same tests
- 524 inconclusive records -> 366 logical inconclusive tests
- 1,221 unknown records -> 829 logical unknown tests

The remaining 54 raw app records roll up to 29 app-managed logical tests.

## Result Semantics

The stored result enum is exactly:

`winner | performed_same | inconclusive | cancelled | running | unknown`

`Performed similarly` is a display label only. The stored value is
`performed_same`.

Separate fields preserve:

- result and result evidence
- explicit winner variant
- descriptive highest-share variant
- reviewer operational decision
- YouTube-applied variant
- inconclusive reason and its evidence

`highest_share_variant` is descriptive only. It never creates `result=winner`.
`insufficient_views` is an inconclusive reason only when explicit Studio or
sheet evidence says so.

## Coverage

Every aggregate includes value, eligible N, included N, coverage rate, quality
band, and denominator type. Denominators are computed from selected data.

- Strict: sheet-backed tests with terminal evidence.
- Wider: strict population plus unknown tests with
  `missing_finish_evidence` whose stored start is at least 21 days before the
  export as-of time.
- Dates do not promote lifecycle status.
- Low: below 40%.
- Partial: 40% through 60%.
- Good: above 60%.

Production-shaped QA on 2026-07-28:

| Metric | Strict: 882 | Wider: 1,129 |
| --- | ---: | ---: |
| Explicit result evidence | 446 (50.6%, partial) | 446 (39.5%, low) |
| Shares present | 453 (51.4%, partial) | 453 (40.1%, partial) |
| Strict title shares | 362 (41.0%, partial) | 362 (32.1%, low) |

The wider population adds tests whose stored start date is **21 days old or
older** (`stored_start_age_days >= 21`) and whose finish was not captured. This
is an explicit reporting definition, not a measured finish event, and it never
changes lifecycle status. On 2026-07-28 it adds 247 tests. Share counts are
logical-test counts. Share-present coverage includes any logical test with a
numeric A/B/C share. Strict title-share coverage additionally requires at least
two stored variant-content slots and a valid 1.00 +/- 0.01 total.

## Variant Reconciliation

Variants exports one row for every A/B/C slot supported by stored option
content, a thumbnail preview, or a numeric watch-time share. Share-only rows
remain useful for analysis but are marked `variant_content_present=false`.

Production-shaped QA on 2026-07-28:

| Exported variant rows per test | Logical tests |
| --- | ---: |
| 0 | 186 |
| 1 | 2 |
| 2 | 1,104 |
| 3 | 12 |

The 1,304 Tests rows reconcile to 2,246 Variants rows. Tests with zero rows are
flagged `missing_variant_rows`; tests with one row are flagged
`incomplete_variant_set`; share-only rows are flagged
`variant_content_missing`. `Tests.exported_variant_count` must equal the number
of Variants rows for that `test_id`.

## Date Quality

Seventy-nine selected tests currently contain stored dates before YouTube
existed. The export:

- preserves those values in Tests and the audit source records;
- marks them `invalid_pre_youtube`;
- adds reproducible Data Quality issue codes;
- excludes them from date-span and duration claims;
- does not guess a replacement year.

This prevents a malformed source date from creating a false 2001 export period
or an invented duration.

## Duration Contract

Duration values are numeric and blank when unavailable:

- `test_duration_hours`
- `detection_delay_hours`
- `review_response_hours`
- `total_cycle_hours`
- `days_open`

Each has a quality field and uncertainty bounds where applicable. `days_open`
records its UTC as-of time. No unavailable duration is exported as text or zero.

## Workbook

ExcelJS generates the `.xlsx` file. JSZip is used only for the optional audit
archive.

Workbook sheets:

1. Summary
2. Tests
3. Variants
4. Actions
5. Video Context
6. Data Quality
7. Data Dictionary

Data sheets are flat tables with headers in row 1, frozen headers, filters,
typed numeric cells, no merged cells, no spacer rows, and no active formulas.
Summary order is identity, scope, limitations, warnings, coverage, KPIs, result
distribution, and channel coverage.

The audit ZIP adds source records, finish signals, scan history, ID history,
identity aliases, a manifest, and SHA-256 checksums.

## YouTube Context

Export-only context uses these read-only YouTube Data API fields:

- `snippet.publishedAt`
- `contentDetails.definition`
- `contentDetails.duration`, parsed to seconds
- `liveStreamingDetails` for archived live streams
- `status.madeForKids`
- `status.privacyStatus`

`context_fetched_at_utc` records when current state was fetched. Normal detector
scans retain their existing snippet-only API request and response contract.

## Security And Privacy

- History export requires an authenticated app session.
- The current shared-workspace authorization model allows authenticated
  reviewers to export the shared data they can view.
- Reviewer notes are excluded by default and require an explicit toggle.
- API keys, tokens, credentials, sheet-access secrets, and app settings are not
  exported.
- Formula-looking text remains a string cell; no formulas are generated.
- Google Sheets and YouTube remain read-only.

## User Experience

The feature is controlled by `HISTORY_EXPORTS_ENABLED` and defaults to `false`.
When enabled, History shows `Export tests`.

The drawer:

- inherits current History filters as read-only chips;
- separates row population from package contents;
- previews logical and raw counts, variants, shares, actions, signals, date
  span, strict/wider denominators, and missing coverage;
- displays blocking, degrading, and informational warnings with actions;
- disables generation for an empty or invalid scope;
- records the creator and last five exports;
- supports re-download when Blob storage is configured and re-run with the same
  filters.

Generation is synchronous. The workbook downloads immediately. If private Blob
storage is configured, the same file is retained for team re-download.

## Verification

The production-data verifier is:

```bash
npm run verify:history-export -- /tmp/youtube-ab-history-export-verification
```

Add `--with-youtube` to verify current Video Context in memory without
persisting or uploading the QA package.

The verifier checks:

- canonical result enum and zero inferred-legacy winners;
- dataset joins and grains;
- exact worksheet set and row counts;
- frozen rows, filters, no merges, and numeric duration cells;
- zero active formulas;
- audit entries and SHA-256 checksums.
