#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(pwd)/recovered-local}"
[[ -d "$ROOT" ]] || { echo "Recovered input directory not found: $ROOT" >&2; exit 1; }

echo '== Provenance =='
cat "$ROOT/CAPTURE_PROVENANCE.txt" 2>/dev/null || true

echo
echo '== Version-bearing files =='
find "$ROOT/runtime" -maxdepth 4 -type f \( -name package.json -o -name plugin.json -o -name '*.py' -o -name '*.md' \) -print0 \
  | xargs -0 grep -nH -E '0\.6\.[0-9]+|VERSION\s*=|serverVersion' 2>/dev/null | head -n 120 || true

echo
echo '== Mutation policy / auxiliary / title controls =='
rg -n --hidden -g '!*.map' \
  'minimal mutating leaf|minimalMutation|auxiliary|session-title-llm|tool_choice|required|visibleTools|str_replace_editor' \
  "$ROOT/runtime" "$ROOT/dsh" 2>/dev/null | head -n 300 || true

echo
echo '== Managed markers =='
find "$ROOT/dsh" \( -name '.codex-harness-bridge-managed.json' -o -name 'bridge-install.json' -o -name 'MANAGED_MARKER.json' \) -print \
  | sort | while read -r f; do echo "--- $f"; cat "$f"; done

echo
echo '== Task summary =='
TASK_JSON="$(find "$ROOT/evidence" -name task.json -print -quit 2>/dev/null || true)"
if [[ -n "$TASK_JSON" ]]; then
  python3 - "$TASK_JSON" <<'TASK_SUMMARY_EOF'
import json,sys
x=json.load(open(sys.argv[1],encoding='utf-8'))
keys=['id','status','phase','model','harnessMode','complexity','infrastructureFailureKind','infrastructureFailureDetails','minimalMutationForceCount','minimalMutationPolicyVersion','minimalMutationForcedTools','toolProtocolNativeCallCount','toolProtocolRecoveryCount','changedPaths','inputTokens','outputTokens']
for k in keys: print(f'{k}: {x.get(k)!r}')
TASK_SUMMARY_EOF
else
  echo 'No task.json captured.'
fi

echo
echo '== Capture checksum =='
(cd "$ROOT" && sha256sum -c CAPTURE_SHA256.txt)
