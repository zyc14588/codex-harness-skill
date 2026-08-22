#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
sha256sum -c MANIFEST_SHA256.txt
python3 - <<'PACKAGE_STRUCTURE_EOF'
from pathlib import Path
root=Path('.')
bad=[]
for p in root.rglob('*'):
    if p.is_symlink(): bad.append(str(p))
    if p.name in {'.git','node_modules'} and p.is_dir(): bad.append(str(p))
if bad:
    raise SystemExit('Forbidden package entries: '+', '.join(bad))
print('Package structure: PASS')
PACKAGE_STRUCTURE_EOF
node --test source/CODEX_HARNESS_BRIDGE_M1_R6_3_BASELINE/bridge/dist/test/*.test.js
