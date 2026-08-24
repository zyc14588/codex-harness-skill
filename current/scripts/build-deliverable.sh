#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${CODEX_HARNESS_DELIVERABLE_DIR:-$(dirname "$SOURCE_ROOT")/deliverables}"
EXTERNAL_EVIDENCE="${CODEX_HARNESS_GITHUB_EVIDENCE:-}"
ARCHIVE_NAME="CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip"
ARCHIVE_ROOT="CODEX_HARNESS_BRIDGE_0_6_6_STABLE"
ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
SECOND_ARCHIVE="$OUTPUT_DIR/.${ARCHIVE_NAME}.determinism-check"
SIDECAR="$ARCHIVE.sha256"
VALIDATION="$ARCHIVE.validation.json"

for command in node npm python3 sha256sum unzip bwrap git cmp; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done
[[ -n "$EXTERNAL_EVIDENCE" && -f "$EXTERNAL_EVIDENCE" ]] \
  || { echo "CODEX_HARNESS_GITHUB_EVIDENCE must name the repository-external exact-tip GitHub attestation" >&2; exit 1; }

# The canonical checkout never claims stable. It must first prove seal_ready
# against repository-external exact-tip GitHub evidence while remaining clean.
node "$SOURCE_ROOT/scripts/verify-release-gate.mjs" \
  --root "$SOURCE_ROOT" \
  --seal-ready \
  --external-evidence "$EXTERNAL_EVIDENCE"

echo "[deliverable 1/10] Reproducible dependency install and strict build"
(cd "$SOURCE_ROOT/bridge" && npm ci && npm run build)

echo "[deliverable 2/10] Full regression, process E2E, and stdio MCP"
(cd "$SOURCE_ROOT/bridge" && npm test && node dist/direct-acceptance.js && node dist/acceptance-client.js)

echo "[deliverable 3/10] Security and skill acceptance"
"$SOURCE_ROOT/scripts/security-acceptance.sh"
node "$SOURCE_ROOT/scripts/validate-skill.mjs" "$SOURCE_ROOT/skills/codex-harness"
(cd "$SOURCE_ROOT" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)

mkdir -p "$OUTPUT_DIR"
TEMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT
STAGING="$TEMP_ROOT/staging"

echo "[deliverable 4/10] Prepare isolated stable metadata and package-origin marker"
node "$SOURCE_ROOT/scripts/prepare-stable-package.mjs" \
  --source "$SOURCE_ROOT" \
  --staging "$STAGING" \
  --external-evidence "$EXTERNAL_EVIDENCE"
node "$STAGING/scripts/update-manifest.mjs" "$STAGING"
(cd "$STAGING" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$STAGING/scripts/verify-release-gate.mjs" --root "$STAGING" --audit-package-staging

echo "[deliverable 5/10] Create and byte-compare two deterministic ZIPs"
python3 "$STAGING/scripts/deterministic-zip.py" "$STAGING" "$ARCHIVE" "$ARCHIVE_ROOT"
python3 "$STAGING/scripts/deterministic-zip.py" "$STAGING" "$SECOND_ARCHIVE" "$ARCHIVE_ROOT"
cmp -s "$ARCHIVE" "$SECOND_ARCHIVE" || { echo "Deterministic ZIP comparison failed" >&2; exit 1; }
rm -f "$SECOND_ARCHIVE"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE_NAME" > "$SIDECAR"

echo "[deliverable 6/10] Unpack and revalidate manifest, source gate, build, and tests"
unzip -q "$ARCHIVE" -d "$TEMP_ROOT"
UNPACKED="$TEMP_ROOT/$ARCHIVE_ROOT"
[[ -d "$UNPACKED" ]]
[[ ! -e "$UNPACKED/bridge/node_modules" ]]
find "$UNPACKED" -type l -print -quit | grep -q . && { echo "Archive contains a symlink" >&2; exit 1; } || true
(cd "$UNPACKED" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
node "$UNPACKED/scripts/verify-release-gate.mjs" --root "$UNPACKED" --audit-package-staging
(cd "$UNPACKED/bridge" && npm ci && npm run build && npm test && node dist/direct-acceptance.js && node dist/acceptance-client.js)
"$UNPACKED/scripts/security-acceptance.sh"
node "$UNPACKED/scripts/validate-skill.mjs" "$UNPACKED/skills/codex-harness"

echo "[deliverable 7/10] Audit transactional install lifecycle from staged package"
CODEX_HARNESS_PACKAGE_STAGING_AUDIT=1 \
CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E=1 \
  "$UNPACKED/scripts/package-acceptance.sh"

echo "[deliverable 8/10] Write exact-byte archive validation hash-chain attestation"
PACKAGE_ORIGIN_SHA="$(sha256sum "$UNPACKED/package-origin.json" | awk '{print $1}')"
SEAL_COMMIT="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sealCommit)' "$UNPACKED/package-origin.json")"
SEAL_TREE="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sealTree)' "$UNPACKED/package-origin.json")"
IMPLEMENTATION_COMMIT="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).implementationCommit)' "$UNPACKED/package-origin.json")"
python3 - "$VALIDATION" "$ARCHIVE_NAME" "$ARCHIVE_SHA" "$PACKAGE_ORIGIN_SHA" "$SEAL_COMMIT" "$SEAL_TREE" "$IMPLEMENTATION_COMMIT" <<'PY'
import hashlib,json,os,sys
target,name,digest,origin_digest,seal_commit,seal_tree,implementation_commit=sys.argv[1:]
chain=hashlib.sha256("\n".join([digest,origin_digest,seal_commit,seal_tree,implementation_commit]).encode()).hexdigest()
value={
  "schemaVersion":2,
  "result":"PASS",
  "archive":name,
  "archiveSha256":digest,
  "packageOriginSha256":origin_digest,
  "sealCommit":seal_commit,
  "sealTree":seal_tree,
  "implementationCommit":implementation_commit,
  "checks":{
    "deterministicDoubleBuild":"PASS",
    "freshInstallLifecycle":"PASS",
    "releaseGate":"PASS",
    "symlinkAndNodeModulesHygiene":"PASS",
    "unpackedBuildAndTests":"PASS",
    "unpackedManifest":"PASS",
    "unpackedPackageAcceptance":"PASS",
    "unpackedSourceGate":"PASS"
  },
  "attestation":{
    "type":"sha256-chain-v1",
    "verified":True,
    "chainSha256":chain
  },
}
temp=target+".tmp"
with open(temp,"w",encoding="utf-8") as handle:
    json.dump(value,handle,indent=2,sort_keys=True)
    handle.write("\n")
os.chmod(temp,0o600)
os.replace(temp,target)
PY

echo "[deliverable 9/10] Bind exact archive and sidecars, then run controlled install lifecycle"
node "$UNPACKED/scripts/verify-release-gate.mjs" \
  --root "$UNPACKED" \
  --require-archive \
  --archive "$ARCHIVE" \
  --sidecar "$SIDECAR" \
  --validation "$VALIDATION"
CODEX_HARNESS_ARCHIVE="$ARCHIVE" \
CODEX_HARNESS_ARCHIVE_SIDECAR="$SIDECAR" \
CODEX_HARNESS_ARCHIVE_VALIDATION="$VALIDATION" \
CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E=1 \
  "$UNPACKED/scripts/package-acceptance.sh"

echo "[deliverable 10/10] Re-run final gate after the install lifecycle"
node "$UNPACKED/scripts/verify-release-gate.mjs" \
  --root "$UNPACKED" \
  --require-archive \
  --archive "$ARCHIVE" \
  --sidecar "$SIDECAR" \
  --validation "$VALIDATION"
printf 'DELIVERABLE_PASS %s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE"
