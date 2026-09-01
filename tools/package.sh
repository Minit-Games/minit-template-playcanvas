#!/usr/bin/env bash
# Build, verify, and produce the ZIP to upload at https://console.minit.games
#
#   npm run package
#
# The ZIP's root is the CONTENTS of dist/ -- index.html at the top, no dist/
# folder, no src/, no package.json, no vite config.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="playcanvas-minit-template"
OUT="dist/${NAME}.zip"

echo "==> building"
npx vite build

echo "==> pre-flight"
node tools/check-meta.mjs

echo "==> offline"
# The engine bundles an asset loader containing fetch and XMLHttpRequest, so a
# grep cannot answer this. Measure what the game actually requests.
node tools/verify-offline.mjs

echo "==> audio"
# A build that is silent inside the app looks healthy from every other angle,
# so this measures the audio graph rather than trusting a flag.
node tools/verify-audio.mjs

echo "==> packaging"
rm -f "$OUT"
(cd dist && zip -qr "${NAME}.zip" . -x "${NAME}.zip")

echo
echo "wrote ${OUT} ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
unzip -l "$OUT" | tail -n +2
echo
echo "Upload ${OUT} at https://console.minit.games"
