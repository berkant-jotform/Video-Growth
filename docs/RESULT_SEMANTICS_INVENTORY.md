# Result Semantics Reader Inventory

This inventory covers every live reader of the legacy `detected_outcome`,
`suggested_winner`, and `winner_reason` fields before the result-semantics
migration. The canonical replacement is:

- `result`
- `result_evidence`
- `result_semantics_version`
- `explicit_winner_variant`
- `highest_share_variant`
- `operational_decision`
- `youtube_applied_variant`
- `inconclusive_reason`
- `inconclusive_reason_evidence`

The stored result enum uses `performed_same`. “Performed similarly” is only its
display label and is never persisted.

`highest_share_variant` is descriptive. It must never be rendered or aggregated
as a YouTube winner.

| Reader | Legacy behavior | Behavior when result is unknown |
| --- | --- | --- |
| `lib/domain.mjs` sheet parser | Converted largest numeric share to `winner_a/b/c`. | Numeric shares keep the row terminal but result is `unknown`; highest share is retained descriptively. |
| `lib/finish-events.mjs` Studio parser | Collapsed Performed Same and Inconclusive into `no_clear`. | Explicit Studio labels remain distinct. Text without an explicit result stays `unknown`. |
| `lib/finish-events.mjs` metadata observer | Labeled an observed B/C metadata application as `winner_b/c`. | Stores `youtube_applied_variant`; result remains `unknown`. |
| `lib/queue-status.mjs` conflict detector | Treated legacy share-derived winner as sheet truth. | Conflicts require an explicit Winner plus explicit A/B/C evidence. Operational decisions may differ from inconclusive/performed-same results without becoming conflicts. |
| `lib/repository.js` queue mapper | Returned legacy result fields directly. | Projects canonical semantics for pre-migration rows and returns unknown rows instead of dropping them. |
| `components/DetectorPage.jsx` cards and drawer | Displayed `Winner B` from `suggested_winner` and preselected it in Done. | Displays `Result unknown`; if shares exist, displays `Highest share B · descriptive, not a YouTube result`. Done is not preselected from shares. |
| `components/DetectorPage.jsx` result filter | `Winner known` matched the legacy card label. | `YouTube winner` matches only canonical Winner. `Result unknown` is directly filterable. |
| `components/ReviewSessionPage.jsx` review header | Displayed `Suggested B`. | Displays the canonical YouTube label or the explicitly descriptive highest-share message. |
| `components/ReviewSessionPage.jsx` share values | Appended `%` to canonical 0-1 values. | Formats 0-1 values as real percentages. |
| `components/HistoryPage.jsx` | Filters and renders reviewer actions, not experiment result. | No row is dropped. Reviewer action remains an operational decision and continues to support correction/undo. |
| `lib/notifications.js` email/Slack cards | Displayed Winner from `suggested_winner`. | Uses canonical YouTube result; unknown may show the descriptive highest-share message. |
| `app/api/queue/route.js` unregistered Studio cards | Exposed only legacy detected outcome. | Exposes canonical Studio result fields and preserves unknown. |
| `app/api/troubleshooting/bundle/route.js` | Included legacy detected outcome in samples. | Legacy fields remain available for audit; canonical fields are added to the troubleshooting payload. |
| Test fixtures | Asserted numeric shares create winners and Performed Same equals No Clear. | Fixtures assert the six-value result contract and the descriptive-only share rule. |

## Non-result Status Readers

Queue KPIs such as Confirmed Finished, Watching, Needs Signal, and Missing Data
are workflow states, not result distributions. They remain operationally stable.
Dates may create a manual-check reminder, but do not create a canonical
`finished`, `running`, or `cancelled` result.

Non-terminal rows remain `lifecycle_status=unknown`. They are separated only by
data-quality evidence:

- `missing_finish_evidence`: usable start date, no finish evidence.
- `missing_start_and_finish_evidence`: neither usable start nor finish evidence.
