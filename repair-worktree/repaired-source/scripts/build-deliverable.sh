#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${CODEX_HARNESS_DELIVERABLE_DIR:-$(dirname "$SOURCE_ROOT")/deliverables}"
ARCHIVE_NAME="CODEX_HARNESS_BRIDGE_0_6_5_HOTFIX_R4_STABLE.zip"
ARCHIVE_ROOT="CODEX_HARNESS_BRIDGE_0_6_5_HOTFIX_R4_STABLE"
ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
SECOND_ARCHIVE="$OUTPUT_DIR/.${ARCHIVE_NAME}.determinism-check"
SIDECAR="$ARCHIVE.sha256"
VALIDATION="$ARCHIVE.validation.json"

for command in node npm python3 sha256sum unzip bwrap; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" --root "$SOURCE_ROOT"

echo "[deliverable 1/7] Reproducible dependency install and strict build"
(cd "$SOURCE_ROOT/bridge" && npm ci && npm run build)
echo "[deliverable 2/7] Full local regression and process acceptance"
(cd "$SOURCE_ROOT/bridge" && npm test && node dist/direct-acceptance.js)
echo "[deliverable 3/7] Regenerating and verifying package manifest"
node "$SOURCE_ROOT/scripts/update-manifest.mjs" "$SOURCE_ROOT"
(cd "$SOURCE_ROOT" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" --root "$SOURCE_ROOT"

mkdir -p "$OUTPUT_DIR"
echo "[deliverable 4/7] Creating two deterministic ZIPs"
python3 "$SOURCE_ROOT/scripts/deterministic-zip.py" "$SOURCE_ROOT" "$ARCHIVE" "$ARCHIVE_ROOT"
python3 "$SOURCE_ROOT/scripts/deterministic-zip.py" "$SOURCE_ROOT" "$SECOND_ARCHIVE" "$ARCHIVE_ROOT"
cmp -s "$ARCHIVE" "$SECOND_ARCHIVE" || { echo "Deterministic ZIP comparison failed" >&2; exit 1; }
rm -f "$SECOND_ARCHIVE"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE_NAME" > "$SIDECAR"

echo "[deliverable 5/7] Unpacking and revalidating manifest/release gate"
TEMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT
unzip -q "$ARCHIVE" -d "$TEMP_ROOT"
UNPACKED="$TEMP_ROOT/$ARCHIVE_ROOT"
(cd "$UNPACKED" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$UNPACKED/scripts/verify-release-gate.mjs" --root "$UNPACKED"
[[ ! -e "$UNPACKED/bridge/node_modules" ]]
find "$UNPACKED" -type l -print -quit | grep -q . && { echo "Archive contains a symlink" >&2; exit 1; } || true

echo "[deliverable 6/7] Running unpacked transactional package acceptance"
CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E=1 "$UNPACKED/scripts/package-acceptance.sh"

echo "[deliverable 7/7] Writing revalidation sidecar"
python3 - "$VALIDATION" "$ARCHIVE_NAME" "$ARCHIVE_SHA" <<'PY'
import json,os,sys
target,name,digest=sys.argv[1:]
value={
  "schemaVersion":1,
  "result":"PASS",
  "archive":name,
  "archiveSha256":digest,
  "checks":{
    "deterministicDoubleBuild":"PASS",
    "unpackedManifest":"PASS",
    "unpackedReleaseGate":"PASS",
    "unpackedPackageAcceptance":"PASS",
    "symlinkAndNodeModulesHygiene":"PASS"
  }
}
temp=target+".tmp"
with open(temp,"w",encoding="utf-8") as handle:
    json.dump(value,handle,indent=2,sort_keys=True)
    handle.write("\n")
os.chmod(temp,0o600)
os.replace(temp,target)
PY
printf 'DELIVERABLE_PASS %s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE"
