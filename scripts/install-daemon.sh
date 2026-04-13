#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_ROOT="${HOME}/.codex/discord-sentinel"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_NAME="com.codex.discord-sentinel"
PLIST_PATH="${PLIST_DIR}/${PLIST_NAME}.plist"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required"
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex is required"
  exit 1
fi

mkdir -p "${STATE_ROOT}/logs" "${PLIST_DIR}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v bun)</string>
    <string>${REPO_ROOT}/src/index.ts</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${STATE_ROOT}/logs/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${STATE_ROOT}/logs/launchd-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl load "${PLIST_PATH}"

echo "Installed ${PLIST_NAME}"
echo "Logs: ${STATE_ROOT}/logs"

