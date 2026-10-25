#!/bin/bash
# Captures the README screenshots at the TV's 1920x1080 with headless Chrome, against the
# demo library of `dev/mock_server.py --showcase` (start that first, on port 8090), then
# puts each on a wall-mounted TV (dev/mockup.html) as <name>-tv.png.
#   dev/screenshots.sh [out-dir]
set -euo pipefail

OUT="${1:-docs/screenshots}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
URL="http://localhost:8090/"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"

capture() { # out.png, url, width, height
  local profile
  profile=$(mktemp -d) # a fresh profile each time: nothing remembered from earlier runs
  "$CHROME" --headless=new --hide-scrollbars --window-size="$3,$4" --force-device-scale-factor=1 \
    --allow-file-access-from-files --user-data-dir="$profile" --virtual-time-budget=15000 \
    --screenshot="$1" "$2" >/dev/null 2>&1
  rm -rf "$profile"
  echo "$1"
}

for name in slideshow albums settings filmstrip; do
  hash=$name; [ "$name" = slideshow ] && hash=""
  capture "$OUT/$name.png" "$URL#$hash" 1920 1080
done
for name in slideshow albums settings filmstrip; do
  capture "$OUT/$name-tv.png" "file://$PWD/dev/mockup.html?shot=$name" 1600 1000
done
