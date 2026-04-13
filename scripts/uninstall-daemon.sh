#!/bin/bash

set -euo pipefail

PLIST_NAME="com.codex.discord-sentinel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"

launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"

echo "Removed ${PLIST_NAME}"
