#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist"
OUT_FILE="$OUT_DIR/youtube-ab-tests-connector.zip"
PUBLIC_OUT_DIR="$ROOT_DIR/public/downloads"
PUBLIC_OUT_FILE="$PUBLIC_OUT_DIR/youtube-ab-tests-connector.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"
cd "$ROOT_DIR/extension"
zip -r "$OUT_FILE" . -x "*.DS_Store"
mkdir -p "$PUBLIC_OUT_DIR"
cp "$OUT_FILE" "$PUBLIC_OUT_FILE"
echo "$OUT_FILE"
