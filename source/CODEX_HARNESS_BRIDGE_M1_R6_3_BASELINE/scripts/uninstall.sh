#!/usr/bin/env bash
set -Eeuo pipefail
VERSION="0.6.3"
INSTALL_ROOT="${CODEX_HARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-harness-bridge/${VERSION}}"
CONFIG_PATH="${CODEX_HARNESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json}"
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-harness"
if [[ -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" && -f "$CONFIG_PATH" ]]; then
  CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
fi
if command -v codex >/dev/null 2>&1 && codex mcp get codex_harness >/dev/null 2>&1; then
  codex mcp remove codex_harness >/dev/null
fi
rm -rf "$SKILL_ROOT"
if [[ -f "$CONFIG_PATH" && -f "$INSTALL_ROOT/scripts/render-minimal-harness.py" ]]; then
  readarray -t PATHS < <(python3 - "$CONFIG_PATH" <<'PY'
import json, os, sys
try:
    c=json.load(open(sys.argv[1],encoding='utf-8'))
except Exception:
    raise SystemExit(0)
home=os.path.realpath(os.path.expanduser(c.get('dshHome') or os.environ.get('DSH_HOME') or '~/.dsh'))
profile=c.get('harnessMinimalProfile','codex-minimal-headless')
print(os.path.join(home,'profiles',profile))
print(os.path.join(home,'.agent-presets','codex-bridge-minimal'))
PY
)
  if ((${#PATHS[@]} == 2)); then
    python3 "$INSTALL_ROOT/scripts/render-minimal-harness.py" remove \
      --profile-dir "${PATHS[0]}" --preset-dir "${PATHS[1]}" >/dev/null || true
  fi
fi
echo "Removed Codex MCP registration, controller skill, Bridge-managed Harness minimal profile/preset, and stopped the monitor. Config, state, worktrees, logs, and versioned runtime were retained."
