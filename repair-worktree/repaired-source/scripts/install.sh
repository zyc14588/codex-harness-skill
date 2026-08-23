#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

VERSION="0.6.5"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_ROOT="/home/zyc14588/deepseek-harness"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/codex-harness-bridge/${VERSION}"
CONFIG_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/codex-harness-bridge/config.json"
STATE_ROOT_DEFAULT="${XDG_STATE_HOME:-$HOME/.local/state}/codex-harness-bridge"
DSH_HOME_TARGET="${DSH_HOME:-$HOME/.dsh}"
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-harness"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
BUILD_HARNESS="yes"
ALLOW_DIRTY_HARNESS=0
SKIP_SELF_TESTS=0
AUDIT_CANDIDATE=0
ALLOWED_ROOTS=()
MONITOR_PORT=""
PROVIDER_KEY_SOURCE=""
LLAMA_MODE="preserve"
LLAMA_BASE_URL=""
LLAMA_MODEL=""

usage() {
  cat <<USAGE
Usage: $0 [options]
  --harness-root PATH       DeepSeek Harness source checkout (default: $HARNESS_ROOT)
  --allowed-root PATH       Allowed repository root; may be repeated
  --install-root PATH       Runtime installation root
  --config PATH             Bridge config path
  --monitor-port PORT       Loopback dashboard/proxy port (default: preserve or 43127)
  --dsh-home PATH           Harness user-data root (default: DSH_HOME or ~/.dsh)
  --provider-key-file PATH  Private 0600 file containing one raw Provider API key line
  --enable-llama-cpp        Enable automatic local execution for eligible simple leaves
  --disable-llama-cpp       Disable local leaf execution (Harness remains available)
  --llama-base-url URL      Loopback OpenAI-compatible base URL (default: http://127.0.0.1:8080/v1)
  --llama-model NAME        llama.cpp model/alias (default: preserve or local-model)
  --build-harness           Run pnpm run build in Harness checkout (default)
  --no-build-harness        Reuse current apps/cli/lib/bin.js and pin its build tree
  --allow-dirty-harness     Permit tracked Harness changes and record the exception
  --audit-candidate         Explicitly allow audit-only installation of a candidate build
  --skip-self-tests         Candidate audit only: skip deterministic tests; doctor still runs
  -h, --help                Show this help
USAGE
}

need_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || { echo "Option $1 requires a value" >&2; exit 2; }
}

codex_mcp() {
  timeout --foreground --kill-after=5s 30s codex mcp "$@"
}

while (($#)); do
  case "$1" in
    --harness-root|--allowed-root|--install-root|--config|--monitor-port|--dsh-home|--provider-key-file|--llama-base-url|--llama-model)
      need_value "$@"
      case "$1" in
        --harness-root) HARNESS_ROOT="$2" ;;
        --allowed-root) ALLOWED_ROOTS+=("$2") ;;
        --install-root) INSTALL_ROOT="$2" ;;
        --config) CONFIG_PATH="$2" ;;
        --monitor-port) MONITOR_PORT="$2" ;;
        --dsh-home) DSH_HOME_TARGET="$2" ;;
        --provider-key-file) PROVIDER_KEY_SOURCE="$2" ;;
        --llama-base-url) LLAMA_BASE_URL="$2" ;;
        --llama-model) LLAMA_MODEL="$2" ;;
      esac
      shift 2
      ;;
    --enable-llama-cpp) LLAMA_MODE="enable"; shift ;;
    --disable-llama-cpp) LLAMA_MODE="disable"; shift ;;
    --build-harness) BUILD_HARNESS="yes"; shift ;;
    --no-build-harness) BUILD_HARNESS="no"; shift ;;
    --allow-dirty-harness) ALLOW_DIRTY_HARNESS=1; shift ;;
    --audit-candidate) AUDIT_CANDIDATE=1; shift ;;
    --skip-self-tests) SKIP_SELF_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for bin in node git codex python3 tar sha256sum timeout bwrap; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Missing required command: $bin" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 12)) process.exit(1)' \
  || { echo "Node.js >=22.12.0 is required" >&2; exit 1; }
if [[ -n "$MONITOR_PORT" ]]; then
  [[ "$MONITOR_PORT" =~ ^[0-9]+$ ]] && ((MONITOR_PORT >= 1 && MONITOR_PORT <= 65535)) \
    || { echo "--monitor-port must be an integer from 1 to 65535" >&2; exit 2; }
fi

[[ -f "$SOURCE_ROOT/MANIFEST_SHA256.txt" ]] || { echo "Package manifest missing: $SOURCE_ROOT/MANIFEST_SHA256.txt" >&2; exit 1; }
echo "[1/14] Verifying package manifest"
(
  cd "$SOURCE_ROOT"
  sha256sum -c MANIFEST_SHA256.txt >/dev/null
) || { echo "Package manifest verification failed" >&2; exit 1; }
RELEASE_GATE_ARGS=(--root "$SOURCE_ROOT")
((AUDIT_CANDIDATE)) && RELEASE_GATE_ARGS+=(--audit-candidate)
((SKIP_SELF_TESTS)) && RELEASE_GATE_ARGS+=(--skip-self-tests)
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" "${RELEASE_GATE_ARGS[@]}"
for artifact in \
  bridge/dist/index.js bridge/dist/doctor-client.js bridge/dist/monitor-client.js \
  bridge/dist/direct-acceptance.js bridge/dist/acceptance-client.js bridge/dist/minimal-tools-server.js \
  scripts/hash-tree.mjs scripts/verify-release-gate.mjs scripts/render-minimal-harness.py harness/minimal/profile/cordis.patch.yml harness/minimal/preset/agent.cordis.yml.in; do
  [[ -f "$SOURCE_ROOT/$artifact" ]] || { echo "Required prebuilt artifact missing: $artifact" >&2; exit 1; }
done

canonical() {
  python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$1"
}
HARNESS_ROOT="$(canonical "$HARNESS_ROOT")"
INSTALL_ROOT="$(canonical "$INSTALL_ROOT")"
CONFIG_PATH="$(canonical "$CONFIG_PATH")"
STATE_ROOT_DEFAULT="$(canonical "$STATE_ROOT_DEFAULT")"
SKILL_ROOT="$(canonical "$SKILL_ROOT")"
CODEX_CONFIG="$(canonical "$CODEX_CONFIG")"
DSH_HOME_TARGET="$(canonical "$DSH_HOME_TARGET")"
if [[ -n "$PROVIDER_KEY_SOURCE" ]]; then PROVIDER_KEY_SOURCE="$(canonical "$PROVIDER_KEY_SOURCE")"; fi
BWRAP_BINARY="$(canonical "$(command -v bwrap)")"
BWRAP_SHA256="$(sha256sum "$BWRAP_BINARY" | awk '{print $1}')"
[[ "$BWRAP_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid Bubblewrap hash" >&2; exit 1; }
MINIMAL_PROFILE_DIR="$DSH_HOME_TARGET/profiles/codex-minimal-headless"
MINIMAL_PRESET_DIR="$DSH_HOME_TARGET/.agent-presets/codex-bridge-minimal"
[[ -d "$HARNESS_ROOT" ]] || { echo "Harness root not found: $HARNESS_ROOT" >&2; exit 1; }
git -C "$HARNESS_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "Harness root must be a Git checkout: $HARNESS_ROOT" >&2; exit 1; }
[[ "$INSTALL_ROOT" != "$SOURCE_ROOT" ]] || { echo "Install root must not equal the extracted package root" >&2; exit 1; }

if ((${#ALLOWED_ROOTS[@]} == 0)); then
  if [[ -f "$CONFIG_PATH" ]]; then
    mapfile -t ALLOWED_ROOTS < <(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
try:
    cfg=json.load(open(sys.argv[1], encoding="utf-8"))
    for item in cfg.get("allowedRepoRoots", []):
        if isinstance(item, str) and item: print(item)
except Exception:
    pass
PY
)
  fi
  if ((${#ALLOWED_ROOTS[@]} == 0)); then
    if [[ -d /home/zyc14588 ]]; then ALLOWED_ROOTS=(/home/zyc14588); else ALLOWED_ROOTS=("$HOME"); fi
  fi
fi
for i in "${!ALLOWED_ROOTS[@]}"; do
  [[ -d "${ALLOWED_ROOTS[$i]}" ]] || { echo "Allowed repository root does not exist: ${ALLOWED_ROOTS[$i]}" >&2; exit 1; }
  ALLOWED_ROOTS[$i]="$(canonical "${ALLOWED_ROOTS[$i]}")"
done

assert_harness_clean() {
  if ((ALLOW_DIRTY_HARNESS)); then return 0; fi
  local dirty
  dirty="$(git -C "$HARNESS_ROOT" status --porcelain=v1 --untracked-files=no)"
  [[ -z "$dirty" ]] || { echo "Harness checkout has tracked changes:" >&2; printf '%s\n' "$dirty" >&2; exit 1; }
}

assert_harness_clean
HARNESS_CLI="$HARNESS_ROOT/apps/cli/lib/bin.js"
if [[ "$BUILD_HARNESS" == "yes" ]]; then
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required with --build-harness" >&2; exit 1; }
  echo "[2/14] Building DeepSeek Harness source"
  (cd "$HARNESS_ROOT" && pnpm run build)
  assert_harness_clean
else
  echo "[2/14] Reusing existing Harness build by explicit request"
fi
[[ -f "$HARNESS_CLI" ]] || { echo "Harness CLI artifact missing: $HARNESS_CLI" >&2; exit 1; }
HARNESS_COMMIT="$(git -C "$HARNESS_ROOT" rev-parse HEAD)"
HARNESS_BUILD_ROOT="$HARNESS_ROOT/apps/cli/lib"
[[ -d "$HARNESS_BUILD_ROOT" ]] || { echo "Harness build root missing: $HARNESS_BUILD_ROOT" >&2; exit 1; }
HARNESS_BUILD_SHA256="$(node "$SOURCE_ROOT/scripts/hash-tree.mjs" "$HARNESS_BUILD_ROOT")"
[[ "$HARNESS_BUILD_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid Harness build hash" >&2; exit 1; }

TX_ROOT="$(mktemp -d)"
RUNTIME_BACKUP=""
HAD_CONFIG=0
HAD_SKILL=0
HAD_CODEX_CONFIG=0
HAD_MINIMAL_PROFILE=0
HAD_MINIMAL_PRESET=0
SUCCESS=0
OLD_MONITOR_WAS_RUNNING=0
NEW_MONITOR_STARTED=0

if [[ -f "$CONFIG_PATH" ]]; then HAD_CONFIG=1; cp -a "$CONFIG_PATH" "$TX_ROOT/config.json"; fi
if [[ -d "$SKILL_ROOT" ]]; then HAD_SKILL=1; cp -a "$SKILL_ROOT" "$TX_ROOT/skill"; fi
if [[ -f "$CODEX_CONFIG" ]]; then HAD_CODEX_CONFIG=1; cp -a "$CODEX_CONFIG" "$TX_ROOT/codex-config.toml"; fi
for pair in "profile:$MINIMAL_PROFILE_DIR" "preset:$MINIMAL_PRESET_DIR"; do
  kind="${pair%%:*}"; target="${pair#*:}"
  if [[ -e "$target" ]]; then
    [[ -f "$target/.codex-harness-bridge-managed.json" ]] || { echo "Refusing to replace unmanaged Harness $kind: $target" >&2; exit 1; }
    if [[ "$kind" == profile ]]; then HAD_MINIMAL_PROFILE=1; cp -a "$target" "$TX_ROOT/minimal-profile"; else HAD_MINIMAL_PRESET=1; cp -a "$target" "$TX_ROOT/minimal-preset"; fi
  fi
done

monitor_status_pid() {
  local client="${1:-}" cfg="${2:-}"
  [[ -n "$client" && -f "$client" && -f "$cfg" ]] || return 0
  CODEX_HARNESS_CONFIG="$cfg" node "$client" status 2>/dev/null | python3 -c '
import json,sys
try:
    value=json.load(sys.stdin)
    pid=value.get("pid")
    if value.get("ok") is True and isinstance(pid,int) and pid>0: print(pid)
except Exception:
    pass
' || true
}

previous_monitor_client_from_codex_config() {
  local cfg="$1"
  [[ -f "$cfg" ]] || return 0
  python3 - "$cfg" <<'PY'
import ast, os, sys
from pathlib import Path
try:
    lines=Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
    header="[mcp_servers.codex_harness]"
    if header not in lines:
        raise SystemExit(0)
    i=lines.index(header)+1
    args=None
    while i < len(lines):
        line=lines[i].strip()
        if line.startswith("[") and line.endswith("]"):
            break
        if line.startswith("args") and "=" in line:
            value=ast.literal_eval(line.split("=",1)[1].strip())
            if isinstance(value, list): args=value
            break
        i += 1
    if not args:
        raise SystemExit(0)
    for item in args:
        if isinstance(item, str) and item.endswith("/bridge/dist/index.js"):
            candidate=os.path.join(os.path.dirname(item), "monitor-client.js")
            if os.path.isfile(candidate):
                print(os.path.realpath(candidate))
                break
except Exception:
    pass
PY
}

OLD_MONITOR_CLIENT="$(previous_monitor_client_from_codex_config "$CODEX_CONFIG")"
if [[ -z "$OLD_MONITOR_CLIENT" && -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" ]]; then
  OLD_MONITOR_CLIENT="$INSTALL_ROOT/bridge/dist/monitor-client.js"
fi
OLD_MONITOR_PID="$(monitor_status_pid "$OLD_MONITOR_CLIENT" "$CONFIG_PATH")"
if [[ "$OLD_MONITOR_PID" =~ ^[0-9]+$ ]]; then
  OLD_MONITOR_WAS_RUNNING=1
  # Stop through the health-checked monitor client. Never signal a PID from a
  # stale file directly: PID reuse could target an unrelated process.
  CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$OLD_MONITOR_CLIENT" stop >/dev/null 2>&1 || true
fi

stop_new_monitor() {
  if ((NEW_MONITOR_STARTED)) && [[ -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" && -f "$CONFIG_PATH" ]]; then
    CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
  fi
}

rollback() {
  local rc=$?
  trap - EXIT
  if ((SUCCESS == 0)); then
    set +e
    echo "Installation failed; restoring previous runtime, configuration, Codex skill, Harness minimal profile/preset, and monitor state." >&2
    stop_new_monitor
    rm -rf "$INSTALL_ROOT"
    if [[ -n "$RUNTIME_BACKUP" && -d "$RUNTIME_BACKUP" ]]; then mv "$RUNTIME_BACKUP" "$INSTALL_ROOT"; fi
    if ((HAD_CONFIG)); then mkdir -p "$(dirname "$CONFIG_PATH")"; cp -a "$TX_ROOT/config.json" "$CONFIG_PATH"; else rm -f "$CONFIG_PATH"; fi
    if ((HAD_SKILL)); then rm -rf "$SKILL_ROOT"; mkdir -p "$(dirname "$SKILL_ROOT")"; cp -a "$TX_ROOT/skill" "$SKILL_ROOT"; else rm -rf "$SKILL_ROOT"; fi
    if ((HAD_CODEX_CONFIG)); then mkdir -p "$(dirname "$CODEX_CONFIG")"; cp -a "$TX_ROOT/codex-config.toml" "$CODEX_CONFIG"; else rm -f "$CODEX_CONFIG"; fi
    rm -rf "$MINIMAL_PROFILE_DIR" "$MINIMAL_PRESET_DIR"
    if ((HAD_MINIMAL_PROFILE)); then mkdir -p "$(dirname "$MINIMAL_PROFILE_DIR")"; cp -a "$TX_ROOT/minimal-profile" "$MINIMAL_PROFILE_DIR"; fi
    if ((HAD_MINIMAL_PRESET)); then mkdir -p "$(dirname "$MINIMAL_PRESET_DIR")"; cp -a "$TX_ROOT/minimal-preset" "$MINIMAL_PRESET_DIR"; fi
    if ((OLD_MONITOR_WAS_RUNNING)) && [[ -n "$OLD_MONITOR_CLIENT" && -f "$OLD_MONITOR_CLIENT" && -f "$CONFIG_PATH" ]]; then
      CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$OLD_MONITOR_CLIENT" start >/dev/null 2>&1 || true
      # Confirm restoration while the transaction still owns all paths. A
      # failed health check remains visible in the installer log, but must not
      # replace the original installation failure code.
      for _ in {1..20}; do
        [[ "$(monitor_status_pid "$OLD_MONITOR_CLIENT" "$CONFIG_PATH")" =~ ^[0-9]+$ ]] && break
        sleep 0.1
      done
    fi
  fi
  rm -rf "$TX_ROOT"
  exit "$rc"
}
trap rollback EXIT

if [[ -d "$INSTALL_ROOT" ]]; then
  RUNTIME_BACKUP="${INSTALL_ROOT}.backup.$$.$RANDOM"
  [[ ! -e "$RUNTIME_BACKUP" ]] || { echo "Runtime backup path already exists: $RUNTIME_BACKUP" >&2; exit 1; }
  mv "$INSTALL_ROOT" "$RUNTIME_BACKUP"
fi
mkdir -p "$INSTALL_ROOT"
echo "[3/14] Installing self-contained prebuilt runtime"
(
  cd "$SOURCE_ROOT"
  tar --exclude='./bridge/node_modules' --exclude='./.git' -cf - .
) | (cd "$INSTALL_ROOT" && tar -xf -)
[[ -f "$INSTALL_ROOT/bridge/dist/index.js" ]] || { echo "Prebuilt MCP runtime was not installed" >&2; exit 1; }
[[ ! -e "$INSTALL_ROOT/bridge/node_modules" ]] || { echo "Unexpected node_modules in installed runtime" >&2; exit 1; }

mkdir -p "$(dirname "$CONFIG_PATH")"
python3 - "$CONFIG_PATH" "$STATE_ROOT_DEFAULT" "$HARNESS_ROOT" "$HARNESS_CLI" "$HARNESS_BUILD_ROOT" "$HARNESS_COMMIT" "$HARNESS_BUILD_SHA256" "$ALLOW_DIRTY_HARNESS" "$DSH_HOME_TARGET" "$MONITOR_PORT" "$LLAMA_MODE" "$LLAMA_BASE_URL" "$LLAMA_MODEL" "$BWRAP_BINARY" "$BWRAP_SHA256" "${ALLOWED_ROOTS[@]}" <<'PY'
import copy, json, os, sys
(config_path, state_default, harness_root, harness_cli, build_root, commit, build_sha, allow_dirty, dsh_home,
 monitor_port, llama_mode, llama_url, llama_model, bwrap_binary, bwrap_sha256, *roots) = sys.argv[1:]
COMPAT_USD_TO_CNY=7.2
DEFAULT_BUDGET={"gatePolicy":"input_output_tokens","ceilingPolicy":"operator_bounded","enforcement":"hard","maxApiCalls":12,"maxInputTokens":180000,"maxOutputTokens":24000,"maxCostCny":2.5,"maxCostUsd":0.35}
MAXIMUM_BUDGET={"gatePolicy":"input_output_tokens","ceilingPolicy":"operator_bounded","enforcement":"hard","maxApiCalls":40,"maxInputTokens":1000000,"maxOutputTokens":128000,"maxCostCny":36.0,"maxCostUsd":5.0}
DEFAULT_PRO_COMPLEX_BUDGET={"gatePolicy":"input_output_tokens","ceilingPolicy":"unbounded","enforcement":"hard","maxApiCalls":120,"maxInputTokens":4000000,"maxOutputTokens":512000,"maxCostCny":360.0,"maxCostUsd":50.0}
DEFAULT_CNY_PRICING={
  "deepseek-v4-flash":{"inputCacheHitCnyPerMillion":0.02,"inputCacheMissCnyPerMillion":1.0,"outputCnyPerMillion":2.0,
    "inputCacheHitUsdPerMillion":0.0028,"inputCacheMissUsdPerMillion":0.14,"outputUsdPerMillion":0.28},
  "deepseek-v4-pro":{"inputCacheHitCnyPerMillion":0.025,"inputCacheMissCnyPerMillion":3.0,"outputCnyPerMillion":6.0,
    "inputCacheHitUsdPerMillion":0.003625,"inputCacheMissUsdPerMillion":0.435,"outputUsdPerMillion":0.87},
}
OLD_R1_PRICING={
  "deepseek-v4-flash":{"inputCacheHitUsdPerMillion":0.028,"inputCacheMissUsdPerMillion":0.14,"outputUsdPerMillion":0.28},
  "deepseek-v4-pro":{"inputCacheHitUsdPerMillion":0.145,"inputCacheMissUsdPerMillion":1.74,"outputUsdPerMillion":3.48},
}
OLD_R2_PRICING={
  "deepseek-v4-flash":{"inputCacheHitUsdPerMillion":0.0028,"inputCacheMissUsdPerMillion":0.14,"outputUsdPerMillion":0.28},
  "deepseek-v4-pro":{"inputCacheHitUsdPerMillion":0.003625,"inputCacheMissUsdPerMillion":0.435,"outputUsdPerMillion":0.87},
}
try:
    old=json.load(open(config_path, encoding="utf-8")) if os.path.isfile(config_path) else {}
except Exception as exc:
    raise SystemExit(f"Existing bridge config is not valid JSON: {exc}")
config=copy.deepcopy(old) if isinstance(old, dict) else {}
config.update({
    "schemaVersion":7,
    "harnessRoot":os.path.realpath(harness_root),
    "harnessCli":os.path.realpath(harness_cli),
    "harnessBuildRoot":os.path.realpath(build_root),
    "harnessProfile":"headless",
    "harnessMinimalProfile":"codex-minimal-headless",
    "dshHome":os.path.realpath(dsh_home),
    "allowedRepoRoots":[os.path.realpath(x) for x in roots],
    "pinnedHarnessCommit":commit,
    "pinnedHarnessBuildSha256":build_sha,
    "enforceHarnessPin":True,
    "enforceHarnessBuildHash":True,
    "requireCleanRepoAtStart":True,
    "allowDirtyHarnessCheckout":allow_dirty == "1",
})
config.setdefault("stateRoot", os.path.realpath(os.path.expanduser(state_default)))
config.setdefault("defaultRuntimeSeconds", 3600)
config.setdefault("maxRuntimeSeconds", 14400)
config.setdefault("logTailChars", 20000)
default_env=[
    "PATH","LANG","LC_ALL","TERM","COLORTERM","NO_COLOR","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"
]
config["passEnvironment"]=default_env.copy()

config.setdefault("provider", {})
provider=config["provider"] if isinstance(config["provider"],dict) else {}
provider.setdefault("baseUrl","https://api.deepseek.com")
provider.setdefault("apiKeyFile",os.path.join(config["stateRoot"],"secrets","provider.key"))
provider["apiKeyFile"]=os.path.realpath(os.path.expanduser(provider["apiKeyFile"]))
config["provider"]=provider
config["harnessIsolation"]={
    "bubblewrapBinary":os.path.realpath(bwrap_binary),
    "bubblewrapSha256":bwrap_sha256,
    "relayPort":43128,
    "rejectEnvFiles":True,
}

config.setdefault("controller", {})
controller=config["controller"]
for k,v in {
    "maxLeavesPerPlan":32,"maxHarnessWriteLeases":30,"maxHarnessContextFiles":40,
    "maxHarnessAcceptanceCriteria":20,"maxHarnessObjectiveChars":6000,
}.items(): controller.setdefault(k,v)
controller["requirePlan"]=True
controller.setdefault("maxConcurrentHarnessGlobal",4)
controller.setdefault("maxConcurrentHarnessPerRepo",3)
controller.setdefault("preferMinimalHarness",True)
controller.setdefault("splitMemory",{})
for k,v in {
    "enabled":True,"minSamplesForEnforcement":2,"maxEventsPerProfile":64,
    "minimumLeafScale":0.25,"maximumLeafScale":1.5,"anomalyPenalty":0.35,
    "successGrowth":0.12,"tokenSafetyFactor":1.35,
}.items(): controller["splitMemory"].setdefault(k,v)

def migrate_budget(value, defaults, enforcement):
    budget=copy.deepcopy(value) if isinstance(value, dict) else {}
    for field in ("maxApiCalls","maxInputTokens","maxOutputTokens"):
        budget.setdefault(field, defaults[field])
    usd=budget.get("maxCostUsd")
    cny=budget.get("maxCostCny")
    valid_usd=isinstance(usd,(int,float)) and not isinstance(usd,bool) and usd>0
    valid_cny=isinstance(cny,(int,float)) and not isinstance(cny,bool) and cny>0
    if not valid_usd and not valid_cny:
        usd=defaults["maxCostUsd"]
        cny=defaults["maxCostCny"]
    elif not valid_usd:
        usd=float(cny)/COMPAT_USD_TO_CNY
    elif not valid_cny:
        cny=float(usd)*COMPAT_USD_TO_CNY
    budget["maxCostUsd"]=round(float(usd),12)
    budget["maxCostCny"]=round(float(cny),12)
    budget["gatePolicy"]="input_output_tokens"
    budget["ceilingPolicy"]=defaults.get("ceilingPolicy","operator_bounded")
    budget["enforcement"]="hard"
    return budget
controller["defaultHarnessBudget"]=migrate_budget(controller.get("defaultHarnessBudget"),DEFAULT_BUDGET,"hard")
controller["maximumHarnessBudget"]=migrate_budget(controller.get("maximumHarnessBudget"),MAXIMUM_BUDGET,"hard")
controller["defaultProComplexBudget"]=migrate_budget(controller.get("defaultProComplexBudget"),DEFAULT_PRO_COMPLEX_BUDGET,"hard")

config.setdefault("monitor", {})
monitor=config["monitor"]
for k,v in {
    "enabled":True,"host":"127.0.0.1","port":43127,"autoStart":True,"charsPerEstimatedToken":4,
}.items(): monitor.setdefault(k,v)
monitor["enabled"]=True
monitor["autoStart"]=True
monitor["host"]="127.0.0.1"
if monitor_port: monitor["port"]=int(monitor_port)
pricing=monitor.get("pricing")
if not isinstance(pricing,dict) or pricing in (OLD_R1_PRICING,OLD_R2_PRICING):
    monitor["pricing"]=copy.deepcopy(DEFAULT_CNY_PRICING)
    monitor["pricingAsOf"]="2026-08-19 DeepSeek official Models & Pricing (CNY primary); local estimate only"
else:
    monitor.setdefault("pricingAsOf","custom operator pricing; local estimate only")
monitor.setdefault("currency", {})
currency=monitor["currency"]
currency.setdefault("primary","CNY")
currency.setdefault("showUsd",False)
currency.setdefault("usdToCnyRate",None)
currency.setdefault("fxAsOf","not-configured")
currency.setdefault("fxSource","manual compatibility conversion; hidden by default")
currency["primary"]="CNY"

config.setdefault("llamaCpp", {})
llama=config["llamaCpp"]
for k,v in {
    "enabled":False,
    "autoRouteSimpleLeaves":True,
    "mode":"external_server",
    "baseUrl":"http://127.0.0.1:8080/v1",
    "apiKeyEnv":"LLAMA_CPP_API_KEY",
    "model":"local-model",
    "serverBinary":"llama-server",
    "serverArgs":[],
    "serverAutoStart":False,
    "serverStartupTimeoutSeconds":90,
    "cliBinary":"llama-cli",
    "cliArgs":["--prompt-file","{{PROMPT_FILE}}","-n","{{MAX_TOKENS}}","--temp","0"],
    "requestTimeoutSeconds":600,
    "maxFilesPerTask":3,
    "maxContextFiles":8,
    "maxContextBytes":512000,
    "maxFileBytes":256000,
    "maxOutputTokens":16384,
    "fallbackEnabled":True,
    "fallbackModel":"deepseek-v4-flash",
}.items(): llama.setdefault(k,v)
llama["apiKeyEnv"]="LLAMA_CPP_API_KEY"
args=llama.get("cliArgs")
if not isinstance(args,list) or not any("{{PROMPT_FILE}}" in str(x) for x in args) or any("{{PROMPT}}" in str(x) for x in args):
    llama["cliArgs"]=["--prompt-file","{{PROMPT_FILE}}","-n","{{MAX_TOKENS}}","--temp","0"]
llama["fallbackModel"]="deepseek-v4-flash"
if llama_mode == "enable": llama["enabled"]=True
elif llama_mode == "disable": llama["enabled"]=False
if llama_url: llama["baseUrl"]=llama_url
if llama_model: llama["model"]=llama_model
if llama.get("enabled") and llama.get("mode") in ("managed_server","cli"):
    prefix="server" if llama["mode"]=="managed_server" else "cli"
    binary=llama.get(prefix+"Binary")
    digest=llama.get(prefix+"BinarySha256")
    if not isinstance(binary,str) or not os.path.isabs(binary) or not isinstance(digest,str) or len(digest)!=64:
        llama["enabled"]=False

os.makedirs(os.path.dirname(config_path), exist_ok=True)
tmp=config_path+".tmp"
with open(tmp,"w",encoding="utf-8") as f:
    json.dump(config,f,indent=2,ensure_ascii=False)
    f.write("\n")
os.chmod(tmp,0o600)
os.replace(tmp,config_path)
PY

echo "[4/14] Installing private Provider credential for the local broker"
python3 - "$CONFIG_PATH" "$PROVIDER_KEY_SOURCE" "$DSH_HOME_TARGET/.credentials.yaml" <<'PY'
import json, os, re, stat, sys
config_path, explicit_source, legacy_source = sys.argv[1:]
cfg=json.load(open(config_path,encoding="utf-8"))
target=os.path.abspath(os.path.expanduser(cfg["provider"]["apiKeyFile"]))

def private_regular(path,label):
    info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode): raise SystemExit(f"{label} must be a regular non-symlink file")
    if hasattr(os,"getuid") and info.st_uid != os.getuid(): raise SystemExit(f"{label} must be owned by the current user")
    if stat.S_IMODE(info.st_mode) != 0o600: raise SystemExit(f"{label} must have mode 0600")

def raw_key(path,label):
    private_regular(path,label)
    value=open(path,encoding="utf-8").read().strip()
    if len(value.encode("utf-8")) < 24 or "\0" in value or "\n" in value or "\r" in value:
        raise SystemExit(f"{label} must contain one raw API key line of at least 24 bytes")
    return value

def legacy_key(path):
    private_regular(path,"legacy DSH credential")
    document=open(path,encoding="utf-8").read()
    match=re.search(r"^\s*DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$",document,re.MULTILINE)
    if not match: raise SystemExit("legacy DSH credential has no DEEPSEEK_API_KEY")
    value=match.group(1).strip()
    if len(value)>=2 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
    if len(value.encode("utf-8")) < 24 or "\0" in value or "\n" in value or "\r" in value:
        raise SystemExit("legacy DSH Provider API key is malformed")
    return value

if explicit_source:
    source=os.path.abspath(os.path.expanduser(explicit_source))
    value=raw_key(source,"--provider-key-file")
elif os.path.exists(target):
    raw_key(target,"configured Provider API key")
    raise SystemExit(0)
elif os.path.exists(legacy_source):
    value=legacy_key(legacy_source)
else:
    raise SystemExit("Provider API key is missing; supply --provider-key-file PATH (private mode 0600)")

parent=os.path.dirname(target)
os.makedirs(parent,mode=0o700,exist_ok=True)
if os.path.realpath(parent) != os.path.abspath(parent): raise SystemExit("Provider secret directory must not traverse symlinks")
os.chmod(parent,0o700)
tmp=f"{target}.tmp.{os.getpid()}"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
    os.write(fd,(value+"\n").encode("utf-8"))
    os.fsync(fd)
finally:
    os.close(fd)
os.replace(tmp,target)
os.chmod(target,0o600)
PY

echo "[5/14] Installing Bridge-managed Harness minimal profile and progressive-tool preset"
python3 "$INSTALL_ROOT/scripts/render-minimal-harness.py" install \
  --template-root "$INSTALL_ROOT/harness/minimal" \
  --profile-dir "$MINIMAL_PROFILE_DIR" \
  --preset-dir "$MINIMAL_PRESET_DIR" \
  --runtime "$INSTALL_ROOT" \
  --config "$CONFIG_PATH" \
  --node "$(command -v node)" >/dev/null

if ((SKIP_SELF_TESTS)); then
  echo "[5/14] Deterministic package self-tests skipped by explicit request"
else
  echo "[5/14] Running 67 prebuilt unit tests"
  node --test "$INSTALL_ROOT"/bridge/dist/test/*.test.js
  echo "[6/14] Running deterministic controller/monitor/Harness/llama.cpp acceptance"
  node "$INSTALL_ROOT/bridge/dist/direct-acceptance.js"
  echo "[7/14] Running stdio MCP initialize/tools/list/tools/call acceptance"
  node "$INSTALL_ROOT/bridge/dist/acceptance-client.js"
fi

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[6/14]"; else STEP_PREFIX="[8/14]"; fi
echo "$STEP_PREFIX Starting loopback task monitor"
set +e
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" start
MONITOR_RC=$?
set -e
NEW_PID="$(monitor_status_pid "$INSTALL_ROOT/bridge/dist/monitor-client.js" "$CONFIG_PATH")"
if [[ "$NEW_PID" =~ ^[0-9]+$ ]]; then NEW_MONITOR_STARTED=1; fi
((MONITOR_RC == 0)) || exit "$MONITOR_RC"

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[7/14]"; else STEP_PREFIX="[9/14]"; fi
echo "$STEP_PREFIX Running actual Harness provenance/profile and optional llama.cpp doctor"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/doctor-client.js"
NEW_PID="$(monitor_status_pid "$INSTALL_ROOT/bridge/dist/monitor-client.js" "$CONFIG_PATH")"
if [[ "$NEW_PID" =~ ^[0-9]+$ ]]; then NEW_MONITOR_STARTED=1; fi

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[8/14]"; else STEP_PREFIX="[10/14]"; fi
echo "$STEP_PREFIX Installing Codex controller skill"
rm -rf "$SKILL_ROOT"
mkdir -p "$SKILL_ROOT"
cp -a "$INSTALL_ROOT/skills/codex-harness/." "$SKILL_ROOT/"

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[9/14]"; else STEP_PREFIX="[11/14]"; fi
echo "$STEP_PREFIX Registering required Codex stdio MCP server"
mkdir -p "$(dirname "$CODEX_CONFIG")"
if codex_mcp get codex_harness >/dev/null 2>&1; then codex_mcp remove codex_harness >/dev/null; fi
codex_mcp add codex_harness --env "CODEX_HARNESS_CONFIG=$CONFIG_PATH" -- node "$INSTALL_ROOT/bridge/dist/index.js"
echo "  Codex MCP add: PASS"
python3 - "$CODEX_CONFIG" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
if not p.is_file(): raise SystemExit("Codex config.toml was not created")
lines=p.read_text(encoding="utf-8").splitlines()
h="[mcp_servers.codex_harness]"
if h not in lines: raise SystemExit("Codex MCP table was not created")
i=lines.index(h)
j=i+1
while j<len(lines) and not (lines[j].startswith("[") and lines[j].endswith("]")): j+=1
managed={"startup_timeout_sec","tool_timeout_sec","required"}
body=[]
for line in lines[i+1:j]:
    key=line.split("=",1)[0].strip() if "=" in line else ""
    if key not in managed: body.append(line)
replacement=[h,"startup_timeout_sec = 30","tool_timeout_sec = 7200","required = true",*body]
p.write_text("\n".join(lines[:i]+replacement+lines[j:])+"\n",encoding="utf-8")
PY
echo "  Codex MCP table normalization: PASS"
codex_mcp get codex_harness >/dev/null
echo "  Codex MCP get: PASS"
python3 - "$CODEX_CONFIG" "$CONFIG_PATH" "$INSTALL_ROOT/bridge/dist/index.js" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text(encoding="utf-8")
for expected in [
    "[mcp_servers.codex_harness]",
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 7200",
    "required = true",
    sys.argv[2],
    sys.argv[3],
]:
    if expected not in text: raise SystemExit(f"Codex MCP configuration missing expected value: {expected}")
PY
echo "  Codex MCP config contract: PASS"

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[10/14]"; else STEP_PREFIX="[12/14]"; fi
echo "$STEP_PREFIX Verifying monitor health, snapshot, installed manifest, and config permissions"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" status >/dev/null
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" snapshot >/dev/null
[[ "$(stat -c '%a' "$CONFIG_PATH")" == "600" ]] || { echo "Config permissions are not 0600" >&2; exit 1; }
(
  cd "$INSTALL_ROOT"
  sha256sum -c MANIFEST_SHA256.txt >/dev/null
)

if ((SKIP_SELF_TESTS)); then STEP_PREFIX="[11/14]"; else STEP_PREFIX="[13/14]"; fi
echo "$STEP_PREFIX Committing installation transaction"
if [[ -n "$RUNTIME_BACKUP" && -d "$RUNTIME_BACKUP" ]]; then rm -rf "$RUNTIME_BACKUP"; RUNTIME_BACKUP=""; fi
SUCCESS=1
DASHBOARD="$(python3 - "$CONFIG_PATH" <<'PY'
import json,sys
c=json.load(open(sys.argv[1],encoding="utf-8"))
print(f"http://{c['monitor']['host']}:{c['monitor']['port']}")
PY
)"
printf '\nInstalled runtime: %s\nBridge config:     %s\nHarness commit:    %s\nHarness build SHA: %s\nMinimal profile:   %s\nDashboard:         %s\n' \
  "$INSTALL_ROOT" "$CONFIG_PATH" "$HARNESS_COMMIT" "$HARNESS_BUILD_SHA256" "$MINIMAL_PROFILE_DIR" "$DASHBOARD"
printf 'llama.cpp:         %s\n' "$(python3 - "$CONFIG_PATH" <<'PY'
import json,sys
c=json.load(open(sys.argv[1],encoding='utf-8'))
print('ENABLED' if c['llamaCpp']['enabled'] else 'DISABLED')
PY
)"
echo 'Restart Codex, then invoke: $codex-harness'
