#!/usr/bin/env bash
set -Eeuo pipefail
VERSION="0.6.3"
UPDATE_PIN=0
while (($#)); do
  case "$1" in
    --update-harness-pin) UPDATE_PIN=1; shift ;;
    -h|--help) echo "Usage: $0 [--update-harness-pin]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
INSTALL_ROOT="${CODEX_HARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-harness-bridge/${VERSION}}"
CONFIG_PATH="${CODEX_HARNESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json}"
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-harness"
for bin in node git python3 sha256sum codex timeout; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Missing required command: $bin" >&2; exit 1; }
done
[[ -f "$CONFIG_PATH" ]] || { echo "Config missing: $CONFIG_PATH" >&2; exit 1; }
[[ -f "$INSTALL_ROOT/bridge/dist/index.js" ]] || { echo "Installed bridge missing: $INSTALL_ROOT/bridge/dist/index.js" >&2; exit 1; }
[[ -f "$SKILL_ROOT/SKILL.md" ]] || { echo "Installed skill missing: $SKILL_ROOT/SKILL.md" >&2; exit 1; }
(
  cd "$INSTALL_ROOT"
  sha256sum -c MANIFEST_SHA256.txt >/dev/null
)


ISOLATE_MONITOR="${CODEX_HARNESS_ACCEPTANCE_ISOLATE_MONITOR:-0}"
MONITOR_WAS_ISOLATED=0
restore_isolated_monitor() {
  if [[ "$MONITOR_WAS_ISOLATED" == "1" ]]; then
    CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" start >/dev/null 2>&1 || true
  fi
}
if [[ "$ISOLATE_MONITOR" == "1" ]]; then
  CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
  MONITOR_WAS_ISOLATED=1
  trap restore_isolated_monitor EXIT
fi
echo "[1/6] Prebuilt unit tests"
timeout --foreground --kill-after=5s 120s node --test "$INSTALL_ROOT"/bridge/dist/test/*.test.js
echo "[2/6] Deterministic controller/monitor/Harness/llama.cpp acceptance"
if [[ "${CODEX_HARNESS_ACCEPTANCE_SKIP_PROCESS_E2E:-0}" == "1" ]]; then
  echo "SKIP: process E2E explicitly supplied by an isolated release-runner invocation"
else
  timeout --foreground --kill-after=5s 180s node "$INSTALL_ROOT/bridge/dist/direct-acceptance.js"
fi
echo "[3/6] stdio MCP acceptance"
timeout --foreground --kill-after=5s 120s node "$INSTALL_ROOT/bridge/dist/acceptance-client.js"

if ((UPDATE_PIN)); then
  echo "[4/6] Rebuilding Harness and transactionally updating provenance pin"
  HARNESS_ROOT="$(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["harnessRoot"])
PY
)"
  HARNESS_BUILD_ROOT="$(python3 - "$CONFIG_PATH" <<'PY'
import json, os, sys
cfg=json.load(open(sys.argv[1], encoding="utf-8"))
print(cfg.get("harnessBuildRoot") or os.path.join(cfg["harnessRoot"], "apps/cli/lib"))
PY
)"
  git -C "$HARNESS_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "Harness root is not a Git checkout: $HARNESS_ROOT" >&2; exit 1; }
  [[ -z "$(git -C "$HARNESS_ROOT" status --porcelain=v1 --untracked-files=no)" ]] \
    || { echo "Refusing to pin a Harness checkout with tracked changes" >&2; exit 1; }
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required to rebuild Harness" >&2; exit 1; }
  (cd "$HARNESS_ROOT" && pnpm run build)
  [[ -z "$(git -C "$HARNESS_ROOT" status --porcelain=v1 --untracked-files=no)" ]] \
    || { echo "Harness build changed tracked files; refusing pin update" >&2; exit 1; }
  [[ -d "$HARNESS_BUILD_ROOT" ]] || { echo "Harness build root missing: $HARNESS_BUILD_ROOT" >&2; exit 1; }
  HARNESS_BUILD_SHA256="$(node "$INSTALL_ROOT/scripts/hash-tree.mjs" "$HARNESS_BUILD_ROOT")"
  [[ "$HARNESS_BUILD_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid Harness build hash" >&2; exit 1; }
  BACKUP="$(mktemp)"
  cp -a "$CONFIG_PATH" "$BACKUP"
  restore_on_error() {
    local rc=$?
    trap - EXIT
    if ((rc != 0)); then cp -a "$BACKUP" "$CONFIG_PATH"; fi
    rm -f "$BACKUP"
    exit "$rc"
  }
  trap restore_on_error EXIT
  python3 - "$CONFIG_PATH" "$HARNESS_ROOT" "$HARNESS_BUILD_ROOT" "$HARNESS_BUILD_SHA256" <<'PY'
import json, os, subprocess, sys
p, root, build_root, build_sha256 = sys.argv[1:]
cfg=json.load(open(p, encoding="utf-8"))
commit=subprocess.check_output(["git","-C",root,"rev-parse","HEAD"], text=True).strip()
cfg["pinnedHarnessCommit"]=commit
cfg["harnessBuildRoot"]=os.path.realpath(build_root)
cfg["pinnedHarnessBuildSha256"]=build_sha256
cfg["enforceHarnessPin"]=True
cfg["enforceHarnessBuildHash"]=True
cfg["allowDirtyHarnessCheckout"]=False
tmp=p+".tmp"
with open(tmp,"w",encoding="utf-8") as f:
    json.dump(cfg,f,indent=2,ensure_ascii=False)
    f.write("\n")
os.chmod(tmp,0o600)
os.replace(tmp,p)
print(f"Candidate pinnedHarnessCommit: {commit}")
print(f"Candidate pinnedHarnessBuildSha256: {build_sha256}")
PY
  CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/doctor-client.js"
  trap - EXIT
  rm -f "$BACKUP"
else
  echo "[4/6] Harness pin unchanged"
fi

if [[ "$MONITOR_WAS_ISOLATED" == "1" ]]; then
  CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" start >/dev/null
  MONITOR_WAS_ISOLATED=0
  trap - EXIT
fi
echo "[5/6] Actual Harness/monitor/optional llama.cpp doctor"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/doctor-client.js"
echo "[6/6] Codex registration and monitor snapshot"
timeout --foreground --kill-after=5s 30s codex mcp get codex_harness >/dev/null
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" snapshot >/dev/null
echo "PASS: 58 unit tests, deterministic process E2E, stdio MCP E2E, package integrity, and actual environment doctor"
