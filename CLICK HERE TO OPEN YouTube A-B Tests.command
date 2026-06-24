#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="127.0.0.1"
PORT="8770"
URL="http://$HOST:$PORT"

show_error() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo
    echo "Something went wrong while opening YouTube A-B Tests."
    echo
    echo "Please send this Terminal window text to the person who shared the app."
    echo
    read -r -p "Press Return to close this window."
  fi
}
trap show_error EXIT

open_app_browser() {
  if ! open "$URL"; then
    echo "The app is running, but the browser did not open automatically."
    echo "Open this link manually:"
    echo "$URL"
    return 1
  fi
}

is_app_healthy() {
  curl -fsS "$URL/api/status" 2>/dev/null | grep -q '"app": "YouTube A-B Tests"'
}

is_port_busy() {
  nc -z "$HOST" "$PORT" >/dev/null 2>&1
}

echo "YouTube A-B Tests"
echo
echo "Folder:"
echo "$ROOT_DIR"
echo

cd "$ROOT_DIR"

if is_app_healthy; then
  echo "The app is already running."
  echo "Opening the browser..."
  open_app_browser || true
  exit 0
fi

if is_port_busy; then
  echo "Port $PORT is already in use, but the app there is not ready."
  echo "Close the other process using port $PORT, then double-click this launcher again."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing on this computer."
  echo "Install Node.js, then double-click this launcher again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing on this computer."
  echo "Install Node.js/npm, then double-click this launcher again."
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "First-time setup is needed."
  echo "This may take a minute."
  if ! npm install; then
    echo "Could not install the app dependencies."
    exit 1
  fi
  echo
fi

echo "Opening the browser..."
(sleep 1.5 && open_app_browser >/dev/null 2>&1 || true) &
echo
echo "Starting the local app. Keep this window open while using it."
echo "Close this window or press Control+C when you are done."
echo "If the browser does not open, use this link: $URL"
echo

npm run dev
