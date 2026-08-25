#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

VERSION="0.6.6"
SCRIPT_RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${CODEX_HARNESS_INSTALL_ROOT:-$SCRIPT_RUNTIME}"
CONFIG_PATH="${CODEX_HARNESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json}"
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-harness"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

canonical() {
  python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$1"
}

INSTALL_ROOT="$(canonical "$INSTALL_ROOT")"
CONFIG_PATH="$(canonical "$CONFIG_PATH")"
case "$(basename "$INSTALL_ROOT")" in
  "$VERSION"|"$VERSION"-candidate-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "Refusing to uninstall an unsafe or non-versioned runtime path: $INSTALL_ROOT" >&2; exit 1 ;;
esac
[[ "$INSTALL_ROOT" != "/" && "$INSTALL_ROOT" != "$HOME" ]] || { echo "Refusing broad uninstall target" >&2; exit 1; }

registration_points_to_runtime() {
  [[ -f "$CODEX_CONFIG" ]] || return 1
  python3 - "$CODEX_CONFIG" "$INSTALL_ROOT/bridge/dist/index.js" <<'PY'
import ast, sys
from pathlib import Path
lines=Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
header="[mcp_servers.codex_harness]"
if header not in lines: raise SystemExit(1)
i=lines.index(header)+1
while i < len(lines):
    line=lines[i].strip()
    if line.startswith("[") and line.endswith("]"): break
    if line.startswith("args") and "=" in line:
        try: args=ast.literal_eval(line.split("=",1)[1].strip())
        except Exception: raise SystemExit(1)
        raise SystemExit(0 if isinstance(args,list) and sys.argv[2] in args else 1)
    i += 1
raise SystemExit(1)
PY
}

ACTIVE=0
if registration_points_to_runtime; then ACTIVE=1; fi
if ((ACTIVE)); then
  if [[ -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" && -f "$CONFIG_PATH" ]]; then
    CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
  fi
  if command -v codex >/dev/null 2>&1 && codex mcp get codex_harness >/dev/null 2>&1; then
    codex mcp remove codex_harness >/dev/null
  fi
  rm -rf -- "$SKILL_ROOT"
fi

if ((ACTIVE)) && [[ -f "$CONFIG_PATH" && -f "$INSTALL_ROOT/scripts/render-minimal-harness.py" ]]; then
  readarray -t PATHS < <(python3 - "$CONFIG_PATH" <<'PY'
import json, os, sys
try: c=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception: raise SystemExit(0)
home=os.path.realpath(os.path.expanduser(c.get("dshHome") or os.environ.get("DSH_HOME") or "~/.dsh"))
profile=c.get("harnessMinimalProfile","codex-minimal-headless")
print(os.path.join(home,"profiles",profile))
print(os.path.join(home,".agent-presets","codex-bridge-minimal"))
PY
  )
  if ((${#PATHS[@]} == 2)); then
    python3 "$INSTALL_ROOT/scripts/render-minimal-harness.py" remove \
      --profile-dir "${PATHS[0]}" --preset-dir "${PATHS[1]}" \
      --expected-runtime "$INSTALL_ROOT" >/dev/null
  fi
fi

rm -rf -- "$INSTALL_ROOT"
printf 'Removed selected runtime: %s\n' "$INSTALL_ROOT"
if ((ACTIVE)); then
  echo "Removed its active Codex MCP, skill, and matching Harness profile/preset. Config, state, worktrees, and logs were retained."
else
  echo "Other active candidate integration was left untouched. Config, state, worktrees, and logs were retained."
fi
