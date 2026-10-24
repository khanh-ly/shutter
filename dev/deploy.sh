#!/bin/bash
# Builds, signs, installs and launches the app on a TV in Developer Mode.
#   dev/deploy.sh <TV-IP> [security-profile]
set -euo pipefail

TV="${1:?usage: dev/deploy.sh <TV-IP> [security-profile]}"
PROFILE="${2:-Shutter}"
APP_ID="SynFrame01.SynologyFrame"
TARGET="$TV:26101"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"
cd "$(dirname "$0")/.."

sdb connect "$TV" >/dev/null || true
if ! sdb devices | grep -q "^$TARGET"; then
  # The local sdb server sometimes loses the TV after a while; restart it once.
  sdb kill-server >/dev/null 2>&1 || true
  sdb start-server >/dev/null 2>&1
  sdb connect "$TV" >/dev/null || true
fi
sdb devices | grep -q "^$TARGET" || { echo "Can't reach the TV at $TARGET. Is Developer Mode on? (See README: Troubleshooting.)"; exit 1; }

rm -rf .buildResult
tizen build-web -e ".*" -e "dev/*" -e "docs/*" -e "README.md" -- . >/dev/null
tizen package -t wgt -s "$PROFILE" -- .buildResult >/dev/null

# The package is named after the app (e.g. "Shutter.wgt"), but the TV's
# installer fails on file names with spaces, so give it a plain name.
WGT=$(ls .buildResult/*.wgt | head -1)
mv "$WGT" .buildResult/Shutter.wgt
push() { sdb -s "$TARGET" push .buildResult/Shutter.wgt /home/owner/share/tmp/sdk_tools/tmp/Shutter.wgt >/dev/null 2>&1; }
if ! push; then
  # A stale sdb connection can still list the TV but fail to transfer ("failed to open
  # sync channel"); reconnect once and retry.
  sdb kill-server >/dev/null 2>&1 || true
  sdb start-server >/dev/null 2>&1
  sdb connect "$TV" >/dev/null || true
  push || { echo "Couldn't send the app to the TV at $TARGET."; exit 1; }
fi
sdb -s "$TARGET" shell 0 vd_appinstall "$APP_ID" /home/owner/share/tmp/sdk_tools/tmp/Shutter.wgt | tail -2
sdb -s "$TARGET" shell 0 was_execute "$APP_ID" | grep -i launch | tail -1
