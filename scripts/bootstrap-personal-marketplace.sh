#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="discord-codex-assistant"
PLUGIN_SOURCE="${REPO_ROOT}/plugins/${PLUGIN_NAME}"
PLUGIN_TARGET="${HOME}/.codex/plugins/${PLUGIN_NAME}"
MARKETPLACE_PATH="${HOME}/.agents/plugins/marketplace.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required"
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex is required"
  exit 1
fi

mkdir -p "${HOME}/.codex/plugins" "${HOME}/.agents/plugins"

echo "Installing repo dependencies..."
(cd "${REPO_ROOT}" && bun install)

rm -rf "${PLUGIN_TARGET}"
cp -R "${PLUGIN_SOURCE}" "${PLUGIN_TARGET}"
chmod +x "${PLUGIN_TARGET}/scripts/run-mcp-server.sh"
printf '%s\n' "${REPO_ROOT}" > "${PLUGIN_TARGET}/.repo-root"

cat > "${PLUGIN_TARGET}/.mcp.json" <<MCP
{
  "mcpServers": {
    "discord-codex-sentinel": {
      "command": "bash",
      "args": ["${PLUGIN_TARGET}/scripts/run-mcp-server.sh"],
      "note": "Local MCP server for Discord Codex Sentinel. This install is pinned to ${REPO_ROOT}."
    }
  }
}
MCP

python3 - "${MARKETPLACE_PATH}" "${PLUGIN_NAME}" <<'PY'
import json
import os
import sys
from pathlib import Path

marketplace_path = Path(sys.argv[1])
plugin_name = sys.argv[2]

entry = {
    "name": plugin_name,
    "source": {
        "source": "local",
        "path": f"./.codex/plugins/{plugin_name}",
    },
    "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    },
    "category": "Productivity",
}

if marketplace_path.exists():
    data = json.loads(marketplace_path.read_text())
else:
    data = {}

plugins = data.get("plugins")
if not isinstance(plugins, list):
    plugins = []

filtered = [plugin for plugin in plugins if plugin.get("name") != plugin_name]
filtered.append(entry)

data["name"] = data.get("name") or "personal-plugins"
interface = data.get("interface")
if not isinstance(interface, dict):
    interface = {}
interface["displayName"] = interface.get("displayName") or "Personal Plugins"
data["interface"] = interface
data["plugins"] = filtered

marketplace_path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Registered ${PLUGIN_NAME} in your Codex personal marketplace source."
echo "Plugin source: ${PLUGIN_TARGET}"
echo "Marketplace: ${MARKETPLACE_PATH}"
echo "Next:"
echo "1. Restart Codex."
echo "2. Open Plugins in the app, or run 'codex' then '/plugins' in the CLI."
echo "3. Choose the 'Personal Plugins' marketplace."
echo "4. Open '${PLUGIN_NAME}' and select Install."
echo "5. Start a new thread and use the plugin's install skill."
