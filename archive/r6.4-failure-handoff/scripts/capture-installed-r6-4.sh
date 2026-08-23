#!/usr/bin/env bash
set -euo pipefail
umask 077

RUNTIME="/home/zyc14588/.local/share/codex-harness-bridge/0.6.4"
CONFIG="/home/zyc14588/.config/codex-harness-bridge/config.json"
DSH_HOME="${DSH_HOME:-/home/zyc14588/.dsh}"
TASK_ID="plan-1787365388387-r6-4-minimal-aux-isolation-smoke"
OUTPUT="$(pwd)/recovered-local"

usage(){ cat <<'CAPTURE_USAGE_EOF'
Usage: capture-installed-r6-4.sh [options]
  --runtime PATH
  --config PATH
  --dsh-home PATH
  --task-id ID
  --output PATH
CAPTURE_USAGE_EOF
}

while (($#)); do
  case "$1" in
    --runtime) RUNTIME="$2"; shift 2;;
    --config) CONFIG="$2"; shift 2;;
    --dsh-home) DSH_HOME="$2"; shift 2;;
    --task-id) TASK_ID="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done

RUNTIME="$(realpath -e "$RUNTIME")"
CONFIG="$(realpath -e "$CONFIG")"
DSH_HOME="$(realpath -m "$DSH_HOME")"
OUTPUT="$(realpath -m "$OUTPUT")"
PROFILE="$DSH_HOME/profiles/codex-minimal-headless"
PRESET="$DSH_HOME/.agent-presets/codex-bridge-minimal"

[[ -d "$RUNTIME" ]] || { echo "Runtime missing: $RUNTIME" >&2; exit 1; }
[[ -f "$CONFIG" ]] || { echo "Config missing: $CONFIG" >&2; exit 1; }
[[ -d "$PROFILE" ]] || { echo "Managed profile missing: $PROFILE" >&2; exit 1; }
[[ -d "$PRESET" ]] || { echo "Managed preset missing: $PRESET" >&2; exit 1; }

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/runtime" "$OUTPUT/dsh" "$OUTPUT/evidence"
cp -a "$RUNTIME"/. "$OUTPUT/runtime/"
cp -a "$PROFILE" "$OUTPUT/dsh/profile-codex-minimal-headless"
cp -a "$PRESET" "$OUTPUT/dsh/preset-codex-bridge-minimal"

python3 - "$CONFIG" "$OUTPUT/config.redacted.json" <<'CONFIG_REDACT_EOF'
import json,sys,re,os
src,dst=sys.argv[1:]
data=json.load(open(src,encoding='utf-8'))
secret=re.compile(r'(api.?key|token|secret|password|authorization|credential)',re.I)
def clean(v,k=''):
    if secret.search(k): return '<REDACTED>'
    if isinstance(v,dict): return {a:clean(b,a) for a,b in v.items()}
    if isinstance(v,list): return [clean(x,k) for x in v]
    return v
with open(dst,'w',encoding='utf-8') as f:
    json.dump(clean(data),f,indent=2,ensure_ascii=False); f.write('\n')
os.chmod(dst,0o600)
CONFIG_REDACT_EOF

STATE_ROOT="$(python3 - "$CONFIG" <<'STATE_ROOT_EOF'
import json,sys
c=json.load(open(sys.argv[1],encoding='utf-8'))
print(c.get('stateRoot',''))
STATE_ROOT_EOF
)"
TASK_JSON=""
if [[ -n "$STATE_ROOT" && -d "$STATE_ROOT" ]]; then
  TASK_JSON="$(find "$STATE_ROOT" -type f -path "*/$TASK_ID/task.json" -print -quit 2>/dev/null || true)"
fi
if [[ -z "$TASK_JSON" ]]; then
  TASK_JSON="$(find /home/zyc14588 -type f -path "*/$TASK_ID/task.json" -print -quit 2>/dev/null || true)"
fi
if [[ -n "$TASK_JSON" ]]; then
  cp -a "$(dirname "$TASK_JSON")" "$OUTPUT/evidence/task-$TASK_ID"
else
  printf 'Task evidence not found automatically for %s\n' "$TASK_ID" > "$OUTPUT/evidence/TASK_NOT_FOUND.txt"
fi

{
  printf 'capturedAt=%s\n' "$(date -u +%FT%TZ)"
  printf 'runtime=%s\nconfig=%s\ndshHome=%s\nprofile=%s\npreset=%s\ntaskId=%s\n' \
    "$RUNTIME" "$CONFIG" "$DSH_HOME" "$PROFILE" "$PRESET" "$TASK_ID"
  printf 'runtimeVersion='; node -e "console.log(require('$RUNTIME/bridge/package.json').version)" 2>/dev/null || true
} > "$OUTPUT/CAPTURE_PROVENANCE.txt"

(
  cd "$OUTPUT"
  find . -type f ! -name CAPTURE_SHA256.txt -print0 | sort -z | xargs -0 sha256sum > CAPTURE_SHA256.txt
)

echo "Captured read-only repair inputs at: $OUTPUT"
echo "Review recovered logs for sensitive content before committing or sharing."
