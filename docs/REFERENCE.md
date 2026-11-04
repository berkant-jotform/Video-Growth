# Video-Growth · YouTube A/B Tests: developer reference

Start with [Getting started](GETTING_STARTED.md). This page keeps the workflow details separate from the first-run instructions. Dated release documents retain their original scope; they do not prove the current machine or account is configured.

## Checks

```sh
npm test
npm run build
```

Use the configured project environment for these commands. Any optional live-service check needs its own setup and approval. Do not run paid jobs, send email or publish content as an incidental test.

## Workflow

1. Open the app.
2. Configure title and thumbnail spreadsheet IDs in Settings.
3. Open Extension and create a browser connection token for the Chrome profile that is logged into YouTube Studio.
4. Download, extract, and load the Chrome extension. Open the app's Extension page and use **Connect this browser**. Manual token setup remains available only as a fallback.
5. Add monitored channels on the app's Extension page. Channel IDs are resolved automatically from known YouTube metadata when possible.
6. Use `Check now` to read visible Studio/YouTube finish notifications, then use `Scan selected` to refresh sheet and YouTube metadata.
7. The default `Action needed` queue shows real finish signals and manual checks. Choose `Everything` to inspect Watching, Needs Signal, Missing Data, and metadata observations.
8. Review channel-grouped signals:
   - `Confirmed Finished`: Studio bell notification or explicit sheet finish/result signal.
   - `Applied Change Observed`: YouTube metadata visibly changed to a B/C option; useful, but not final proof for A/no-clear cases.
   - `Needs Signal`: no active extension heartbeat covers that channel.
   - `Watching`: active test with no real finish signal yet.
9. Use the dominant `Open Studio` button.
10. After handling the result in Studio, click `Done` and choose A, B, C, No Clear / Not Enough Views, or another explicit outcome.
11. Completed runs move to History for the whole team. A later matching sheet result keeps the run closed; only an explicit conflicting result creates an Action Conflict.

The app tracks both:

- `video_id`: groups tests by YouTube video.
- `test_run_id`: identifies one specific test attempt, including row, dates, and option fingerprint.

That keeps retests on the same video separate.

Detection logic:

- A test is confirmed finished when a Studio bell finish notification is received, a sheet result value exists, or the sheet has an explicit finish date.
- `Start Date + 14` is never treated as proof that a test finished. It can only create the secondary `Needs Manual Check` state.
- A test is already logged when A/B/C watch-time-share percentages or a no-clear-winner text are present.
- Already logged rows are not shown as active Studio work, because the sheet already contains the selected result.
- Entered results override missing-data warnings for queue purposes; the row can be messy, but it is not active Studio work anymore.
- Missing IDs, missing dates, and broken row shapes stay visible at the bottom as fix items.



## Chrome Extension

The extension lives in `extension/`.

Unpacked install for testing:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the `extension/` folder from this repo. For the downloaded build, unzip it first and select the extracted folder.
5. Open the app's Extension page and create a browser connection token.
6. Open the extension Settings.
7. Enter:
   - Cloud app URL, for example `https://video-growth.vercel.app`
   - Browser token from the app's Extension page
   - Reviewer initials
8. Open YouTube Studio in the same Chrome profile and click `Check connection`.
9. Use `Open missing watcher tabs` once. Keep those tabs open for passive hourly checks.

Watcher channels and detection rules are managed in the website. Installed extensions pull those changes automatically. A new zip is only required when the app reports that the extension code version is outdated.

Package for internal sharing:

```bash
npm run package-extension
```

The zip is written to `dist/youtube-ab-tests-connector.zip`.



## Notifications

Implemented:

- In-app counts and badges.
- Browser notifications from the detector screen.
- Slack digest endpoint via `SLACK_WEBHOOK_URL`.

Reserved/configurable:

- SMTP email digest through `SMTP_*` and `DIGEST_EMAIL_RECIPIENTS`.
- Vercel Cron at `/api/cron/scan`, guarded by `CRON_SECRET` when configured.



## Tests

```bash
npm test
```

The tests cover parsing, no-guess finish behavior, Studio notification parsing/matching, watcher resolution and deduplication, metadata-observed detection, winner/no-clear inference, retest IDs, action conflict behavior, missing-data classification, and channel identity normalization.



## Build and repository layout

```sh
npm test
npm run build
```

`app/` contains routes and screens; `components/` contains UI components; `lib/` contains parsing, detection and persistence; `extension/` contains Chrome source; `test/` contains automated checks; `scripts/` contains packaging and maintenance utilities.

Never commit `.env*` secrets, database exports or browser connection tokens. `.env.example` is the placeholder reference. History-export verification and result migration commands require configured live services; they are not ordinary offline tests. A successful offline test suite does not prove installed extension monitoring, live channel access or notification delivery.
