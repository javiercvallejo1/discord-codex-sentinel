#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ROOT="${HOME}/.codex/discord-codex-sentinel-plugin"
MARKETPLACE_DIR="${HOME}/.agents/plugins/discord-codex-local"

mkdir -p "${TARGET_ROOT}" "${MARKETPLACE_DIR}"

rm -rf "${TARGET_ROOT}/plugin"
cp -R "${REPO_ROOT}/plugins/discord-codex-assistant" "${TARGET_ROOT}/plugin"
cp "${REPO_ROOT}/.agents/plugins/marketplace.json" "${MARKETPLACE_DIR}/marketplace.json"

echo "Local plugin files installed."
echo "Plugin root: ${TARGET_ROOT}/plugin"
echo "Marketplace: ${MARKETPLACE_DIR}/marketplace.json"
echo "Use Codex to add the local marketplace and install 'discord-codex-assistant'."
