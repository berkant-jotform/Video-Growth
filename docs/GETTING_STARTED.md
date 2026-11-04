# Getting started with Video-Growth · YouTube A/B Tests

Configured web app plus read-only Chrome extension. A database and session secret are required before saving team state.

## 1. Get the files

In GitHub, choose **Code → Download ZIP** and extract the archive. Open Terminal in that extracted folder. If you prefer Git:

```sh
git clone https://github.com/berkant-jotform/Video-Growth.git
cd Video-Growth
```

Private repositories require an approved GitHub login. Downloaded archives normally have `-main` at the end of the folder name; use that actual folder name if navigating with `cd`.

## 2. Check the requirements

Node.js 24 and npm for this guide, a PostgreSQL database, and Chrome for the extension.

Run `node --version` and `npm --version`. Install Node.js from [nodejs.org](https://nodejs.org/en/download) if either command is missing.

## 3. Install and start

Run these commands from the project folder:

```sh
npm ci
cp .env.example .env.local
```

Before starting, edit `.env.local` and set `DATABASE_URL` to your approved PostgreSQL connection and `SESSION_SECRET` to a private random value. Generate a value locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste it only into your local configuration, then run `npm run dev`. Storage is not ready merely because the page opens. Keep Sheets access private by default; link-accessible Sheets are an optional fallback only for data explicitly approved for that sharing mode.

## 4. Get a first result

Open **http://127.0.0.1:8770**.

Fill `DATABASE_URL` and `SESSION_SECRET` in `.env.local` before running `npm run dev`. Open Settings and confirm storage readiness, then configure approved Sheets and YouTube access. Install and connect the extension only after the app is ready.

## If something does not work

| Symptom | Next step |
| --- | --- |
| A command is not found | Install the required runtime, reopen Terminal, then check its version. |
| The page does not open | Read the server output and open the exact local URL above. Keep that window open. |
| The port is already in use | Close the known app using that port, or use its existing window. Do not terminate an unknown process. |
| An API feature is unavailable | Configure an approved key/account for that feature. Basic startup does not validate provider access. |
| A download is missing | Read the download guide. Source archives and prebuilt installers are different. |

Before reporting a problem, record the step, expected result, actual message and OS/runtime versions. Remove credentials and private data from any screenshot or log. Use the repository issue form for non-sensitive bugs.

## Developer checks

See [Developer reference](REFERENCE.md) for the commands relevant to this project. Passing a local check does not prove live-provider, clean-machine installation or deployment acceptance.
