#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${CODEX_HARNESS_DELIVERABLE_DIR:-$(dirname "$SOURCE_ROOT")/deliverables}"
ARCHIVE_NAME="CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip"
ARCHIVE_ROOT="CODEX_HARNESS_BRIDGE_0_6_6_STABLE"
ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
SECOND_ARCHIVE="$OUTPUT_DIR/.${ARCHIVE_NAME}.determinism-check"
SIDECAR="$ARCHIVE.sha256"
VALIDATION="$ARCHIVE.validation.json"

for command in node npm python3 sha256sum unzip bwrap git; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

# This rejects candidate/withdrawn trees before any stable-named artifact can
# be created. Archive validation is intentionally deferred until the external
# archive and sidecars exist.
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" --root "$SOURCE_ROOT"

echo "[deliverable 1/8] Reproducible dependency install and strict build"
(cd "$SOURCE_ROOT/bridge" && npm ci && npm run build)

echo "[deliverable 2/8] Full regression, process E2E, and stdio MCP"
(cd "$SOURCE_ROOT/bridge" && npm test && node dist/direct-acceptance.js && node dist/acceptance-client.js)

echo "[deliverable 3/8] Security, skill, and transactional package acceptance"
"$SOURCE_ROOT/scripts/security-acceptance.sh"
node "$SOURCE_ROOT/scripts/validate-skill.mjs" "$SOURCE_ROOT/skills/codex-harness"
CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E=1 "$SOURCE_ROOT/scripts/package-acceptance.sh"

echo "[deliverable 4/8] Regenerate manifest and re-evaluate the stable source gate"
node "$SOURCE_ROOT/scripts/update-manifest.mjs" "$SOURCE_ROOT"
(cd "$SOURCE_ROOT" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" --root "$SOURCE_ROOT"

mkdir -p "$OUTPUT_DIR"
echo "[deliverable 5/8] Create and byte-compare two deterministic ZIPs"
python3 "$SOURCE_ROOT/scripts/deterministic-zip.py" "$SOURCE_ROOT" "$ARCHIVE" "$ARCHIVE_ROOT"
python3 "$SOURCE_ROOT/scripts/deterministic-zip.py" "$SOURCE_ROOT" "$SECOND_ARCHIVE" "$ARCHIVE_ROOT"
cmp -s "$ARCHIVE" "$SECOND_ARCHIVE" || { echo "Deterministic ZIP comparison failed" >&2; exit 1; }
rm -f "$SECOND_ARCHIVE"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE_NAME" > "$SIDECAR"

echo "[deliverable 6/8] Unpack and revalidate manifest, build, tests, and install lifecycle"
TEMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT
unzip -q "$ARCHIVE" -d "$TEMP_ROOT"
UNPACKED="$TEMP_ROOT/$ARCHIVE_ROOT"
[[ -d "$UNPACKED" ]]
[[ ! -e "$UNPACKED/bridge/node_modules" ]]
find "$UNPACKED" -type l -print -quit | grep -q . && { echo "Archive contains a symlink" >&2; exit 1; } || true
(cd "$UNPACKED" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$UNPACKED/scripts/verify-release-gate.mjs" --root "$UNPACKED"
(cd "$UNPACKED/bridge" && npm ci && npm run build && npm test)
CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E=1 "$UNPACKED/scripts/package-acceptance.sh"

echo "[deliverable 7/8] Write the archive revalidation sidecar"
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
    "unpackedBuildAndTests":"PASS",
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

echo "[deliverable 8/8] Bind exact archive name and both sidecars through the final gate"
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" \
  --root "$SOURCE_ROOT" \
  --require-archive \
  --archive "$ARCHIVE" \
  --sidecar "$SIDECAR" \
  --validation "$VALIDATION"
printf 'DELIVERABLE_PASS %s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE"
