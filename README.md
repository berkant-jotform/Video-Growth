# YouTube A/B Tests

Cloud-first real finish tracker for YouTube title and thumbnail A/B tests.

V3 is a Next.js app for Vercel plus a read-only Chrome extension for YouTube Studio. Sheets and YouTube Data API keep the active test registry fresh; Studio bell notifications provide the precise early-finish signal. The app keeps shared team state in Postgres, helps reviewers open Studio, and records Done actions. It does not write to Sheets, edit YouTube, upload thumbnails to YouTube, or use Apps Script.

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

After those are configured, use the in-app Settings page to configure:

- Title and thumbnail spreadsheet IDs
- Google service account JSON
- YouTube API key
- Vercel Blob token
- Connector token and monitored channels
- Slack webhook
- SMTP email settings
- Digest recipients

Generate the optional shared password hash:

```bash
npm run hash-password
```

Use a Google service account for private read-only Sheets access, then share the title and thumbnail spreadsheets with the service account email as Viewer. If Google Cloud access is blocked, leave service-account settings empty and share the cloned sheets as `Anyone with the link: Viewer`; the app will read them through Google Sheets XLSX export without using the Sheets API. If service accounts are blocked but you have a valid readonly token, `GOOGLE_OAUTH_ACCESS_TOKEN` is still supported as a fallback.

Neon Postgres is the recommended Vercel database. Vercel Blob is used for thumbnail preview image storage when `BLOB_READ_WRITE_TOKEN` is configured; local development can temporarily store small imported previews as data URLs.

## Workflow

1. Open the app.
2. Configure title and thumbnail spreadsheet IDs in Settings.
3. Configure a connector token in Settings.
4. Install the Chrome extension in the browser profile that is logged into YouTube Studio.
5. Click `Scan Now` to refresh the active test registry.
6. Review channel-grouped real finish signals:
   - `Confirmed Finished`: Studio bell notification or explicit sheet finish/result signal.
   - `Applied Change Observed`: YouTube metadata visibly changed to a B/C option; useful, but not final proof for A/no-clear cases.
   - `Needs Signal`: no active extension heartbeat covers that channel.
   - `Watching`: active test with no real finish signal yet.
7. Use the dominant `Open Studio` button.
8. After handling the result in Studio, click `Done` and choose the outcome.
9. Completed runs move to History for the whole team.

The app tracks both:

- `video_id`: groups tests by YouTube video.
- `test_run_id`: identifies one specific test attempt, including row, dates, and option fingerprint.

That keeps retests on the same video separate.

Detection logic:

- A test is confirmed finished when a Studio bell finish notification is received, a sheet result value exists, or the sheet has an explicit finish date.
- `Start Date + 14` is not used to mark a test finished.
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
4. Select the `extension/` folder from this repo.
5. Open the extension options.
6. Enter:
   - Cloud app URL, for example `https://video-growth.vercel.app`
   - Connector token from app Settings
   - Reviewer initials
   - Monitored channels, starting with `Jotform, AI Agents Podcast, AI Agents`
7. Open YouTube Studio in the same Chrome profile and send a heartbeat from the extension popup.

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

The current tests cover parsing, no-guess finish behavior, Studio notification parsing/matching, metadata-observed detection, winner/no-clear inference, retest IDs, and missing-data classification.
