#!/usr/bin/env bash
set -Eeuo pipefail
VERSION="0.6.5"
INSTALL_ROOT="${CODEX_HARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-harness-bridge/${VERSION}}"
CONFIG_PATH="${CODEX_HARNESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json}"
COMMAND="${1:-status}"
case "$COMMAND" in
  start|status|snapshot|stop) ;;
  correct-cost) (($# >= 4)) || { echo "Usage: $0 correct-cost <budgetGroupId> <correctedCostCny> <reason>" >&2; exit 2; } ;;
  set-fx) (($# >= 4)) || { echo "Usage: $0 set-fx <usdToCnyRate|none> <asOf> <source>" >&2; exit 2; } ;;
  *) echo "Usage: $0 start|status|snapshot|stop|correct-cost|set-fx" >&2; exit 2 ;;
esac
[[ -f "$CONFIG_PATH" ]] || { echo "Bridge config missing: $CONFIG_PATH" >&2; exit 1; }
[[ -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" ]] || { echo "Monitor client missing: $INSTALL_ROOT/bridge/dist/monitor-client.js" >&2; exit 1; }
shift || true
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" "$COMMAND" "$@"
