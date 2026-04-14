#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT_FILE="${PLUGIN_ROOT}/.repo-root"

if [ -f "${REPO_ROOT_FILE}" ]; then
  REPO_ROOT="$(cat "${REPO_ROOT_FILE}")"
else
  REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd)"
fi

exec bun "${REPO_ROOT}/src/index.ts" mcp serve
