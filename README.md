# YouTube A/B Tests

Cloud-first real finish tracker for YouTube title and thumbnail A/B tests.

V4 is a Next.js app for Vercel plus a read-only Chrome extension for YouTube Studio. Sheets and YouTube Data API keep the test registry fresh; Studio bell notifications provide the precise early-finish signal. The app keeps shared team state in Postgres, helps reviewers open Studio, and records Done actions. It does not write to Sheets, edit YouTube, upload thumbnails to YouTube, or use Apps Script.

The active queue is intentionally a finish tracker, not a full control center. If a row already has watch-time percentages or a "not enough impressions" result entered in the sheet, the app treats that run as already logged and keeps it out of the active queue. Blank finish dates do not become finished items from a time guess.

## Local Start

```bash
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:8770
```

The double-click launcher does the same setup/start flow:

```text
CLICK HERE TO OPEN YouTube A-B Tests.command
```

## Required Bootstrap

Create `.env.local` locally or configure these in Vercel first:

```text
SESSION_SECRET=
DATABASE_URL=
```

These are required bootstrap settings. The app cannot save anything until `DATABASE_URL` exists, and it needs `SESSION_SECRET` to sign reviewer sessions.

Optional shared password gate:

```text
APP_SHARED_PASSWORD_HASH=
```

If `APP_SHARED_PASSWORD_HASH` is empty or removed, the login screen asks only for reviewer initials/name. If it is set, reviewers must enter the shared password.

After those are configured, use the app to configure:

- `Settings`: title and thumbnail spreadsheet IDs, optional Google read credentials, YouTube API key, and storage readiness.
- `Extension`: one token per Chrome profile, monitored channels, Studio watcher URLs, and detection reliability rules.
- `Notifications`: one or more team notification profiles with their own channels, test types, statuses, Slack webhook, or email recipient settings.

Generate the optional shared password hash:

```bash
npm run hash-password
```

Use a Google service account for private read-only Sheets access, then share the title and thumbnail spreadsheets with the service account email as Viewer. If Google Cloud access is blocked, leave service-account settings empty and share the cloned sheets as `Anyone with the link: Viewer`; the app will read them through Google Sheets XLSX export without using the Sheets API. If service accounts are blocked but you have a valid readonly token, `GOOGLE_OAUTH_ACCESS_TOKEN` is still supported as a fallback.

Neon Postgres is the recommended Vercel database. Vercel Blob is used for thumbnail preview image storage when `BLOB_READ_WRITE_TOKEN` is configured; local development can temporarily store small imported previews as data URLs.

## Workflow

1. Open the app.
2. Configure title and thumbnail spreadsheet IDs in Settings.
3. Open Extension and create a browser connection token for the Chrome profile that is logged into YouTube Studio.
4. Download, extract, and load the Chrome extension. Paste the app URL and browser token in its Settings page.
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
