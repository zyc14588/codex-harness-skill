#!/usr/bin/env bash
set -Eeuo pipefail
VERSION="0.6.5"
INSTALL_ROOT="${CODEX_HARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-harness-bridge/${VERSION}}"
CONFIG_PATH="${CODEX_HARNESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json}"
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-harness"
for bin in node git codex python3 sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL: missing $bin" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 12)) process.exit(1)' \
  || { echo "FAIL: Node.js >=22.12.0 required" >&2; exit 1; }
[[ -f "$CONFIG_PATH" ]] || { echo "FAIL: config missing: $CONFIG_PATH" >&2; exit 1; }
[[ "$(stat -c '%a' "$CONFIG_PATH")" == "600" ]] || { echo "FAIL: config permissions must be 0600" >&2; exit 1; }
[[ -f "$INSTALL_ROOT/bridge/dist/index.js" ]] || { echo "FAIL: bridge runtime missing: $INSTALL_ROOT/bridge/dist/index.js" >&2; exit 1; }
[[ -f "$INSTALL_ROOT/MANIFEST_SHA256.txt" ]] || { echo "FAIL: installed manifest missing" >&2; exit 1; }
[[ -f "$SKILL_ROOT/SKILL.md" ]] || { echo "FAIL: Codex skill missing: $SKILL_ROOT/SKILL.md" >&2; exit 1; }
(
  cd "$INSTALL_ROOT"
  sha256sum -c MANIFEST_SHA256.txt >/dev/null
)
codex mcp get codex_harness >/dev/null
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/doctor-client.js"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" status >/dev/null
echo "PASS: package integrity, Codex registration, Harness provenance/profile, monitor, and optional llama.cpp probe"
