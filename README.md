# YouTube A/B Tests

Cloud-first test finish detector for YouTube title and thumbnail A/B tests.

V2 is a Next.js app for Vercel. It reads Google Sheets and YouTube Data API data, keeps shared team state in Postgres, and helps reviewers quickly open Studio and mark finished tests as handled. It does not write to Sheets, edit YouTube, upload thumbnails to YouTube, or use Apps Script.

The active queue is intentionally a finish detector, not a full control center. If a row already has watch-time percentages or a "not enough impressions" result entered in the sheet, the app treats that run as already logged and keeps it out of the active queue. The main queue is for tests that appear newly finished by date but still have no result entered.

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
3. Click `Scan Now`.
4. Review channel-grouped newly finished tests.
5. Use the dominant `Open Studio` button.
6. After handling the result in Studio, click `Done` and choose the outcome.
7. Completed runs move to History for the whole team.

The app tracks both:

- `video_id`: groups tests by YouTube video.
- `test_run_id`: identifies one specific test attempt, including row, dates, and option fingerprint.

That keeps retests on the same video separate.

Detection logic:

- A test is newly finished when `Test Finish Date <= today`, or when finish date is blank and `Start Date + 14 <= today`.
- A test is already logged when A/B/C watch-time-share percentages or a no-clear-winner text are present.
- Already logged rows are not shown as active Studio work, because the sheet already contains the selected result.
- Entered results override missing-data warnings for queue purposes; the row can be messy, but it is not newly finished work anymore.
- Missing IDs, missing dates, and broken row shapes stay visible at the bottom as fix items.

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

The current tests cover parsing, date fallback, winner/no-clear inference, hybrid detection, retest IDs, and missing-data classification.
