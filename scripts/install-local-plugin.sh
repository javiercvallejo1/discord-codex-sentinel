#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ROOT="${HOME}/.codex/discord-codex-sentinel-plugin"
MARKETPLACE_DIR="${HOME}/.agents/plugins/discord-codex-local"
PLUGIN_ROOT="${TARGET_ROOT}/plugin"

mkdir -p "${TARGET_ROOT}" "${MARKETPLACE_DIR}"

rm -rf "${PLUGIN_ROOT}"
cp -R "${REPO_ROOT}/plugins/discord-codex-assistant" "${PLUGIN_ROOT}"
cp "${REPO_ROOT}/.agents/plugins/marketplace.json" "${MARKETPLACE_DIR}/marketplace.json"
chmod +x "${PLUGIN_ROOT}/scripts/run-mcp-server.sh"
printf '%s\n' "${REPO_ROOT}" > "${PLUGIN_ROOT}/.repo-root"

cat > "${PLUGIN_ROOT}/.mcp.json" <<MCP
{
  "mcpServers": {
    "discord-codex-sentinel": {
      "command": "bash",
      "args": ["${PLUGIN_ROOT}/scripts/run-mcp-server.sh"],
      "note": "Local MCP server for Discord Codex Sentinel. This install is pinned to ${REPO_ROOT}."
    }
  }
}
MCP

echo "Local plugin files installed."
echo "Plugin root: ${PLUGIN_ROOT}"
echo "Marketplace: ${MARKETPLACE_DIR}/marketplace.json"
echo "Use Codex to add the local marketplace and install 'discord-codex-assistant'."
