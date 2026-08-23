#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.version)' "$SOURCE_ROOT/bridge/package.json")"
for command in node git jq bwrap; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

if git -C "$SOURCE_ROOT" ls-files | grep -E '(^|/)\.env($|\.)' | grep -Ev '\.(example|sample|template|dist)$'; then
  echo "Tracked environment file is forbidden" >&2
  exit 1
fi

jq -e '
  .schemaVersion == 7 and
  .provider.apiKeyFile != null and
  .harnessIsolation.rejectEnvFiles == true and
  (.harnessIsolation.bubblewrapSha256 | test("^[0-9a-f]{64}$")) and
  (.passEnvironment | all(. != "DEEPSEEK_API_KEY" and . != "GITHUB_TOKEN" and . != "LLAMA_CPP_API_KEY")) and
  (.llamaCpp.cliArgs | any(contains("{{PROMPT_FILE}}"))) and
  (.llamaCpp.cliArgs | all(contains("{{PROMPT}}") | not))
' "$SOURCE_ROOT/config/config.example.json" >/dev/null

node "$SOURCE_ROOT/scripts/release-gate.test.mjs" >/dev/null
(cd "$SOURCE_ROOT/bridge" && node --test \
  dist/test/harness-isolation.test.js \
  dist/test/process-group.test.js \
  dist/test/process-identity.test.js \
  dist/test/monitor-lifecycle.test.js \
  dist/test/controls.test.js \
  dist/test/provider-protocol-fail-fast.test.js \
  dist/test/verification-isolation.test.js \
  dist/test/security.test.js >/dev/null)

cat <<JSON
{
  "schemaVersion": 1,
  "version": "$VERSION",
  "result": "PASS",
  "checks": {
    "operatorApiAuthentication": "PASS",
    "providerCredentialBroker": "PASS",
    "bubblewrapFileNetworkPidIsolation": "PASS",
    "trackedEnvRejection": "PASS",
    "minimalEnvironmentAllowlist": "PASS",
    "llamaBinaryAndRuntimeControlPinning": "PASS",
    "promptFileOnlyTransport": "PASS",
    "strongProcessIdentityAndGroupCleanup": "PASS",
    "candidateStableWithdrawnReleaseGates": "PASS",
    "providerCapabilityNegativeMatrix": "PASS",
    "reasoningReplayPreProviderFailFast": "PASS",
    "ignoredArtifactPoisoningIsolation": "PASS",
    "operatorAuthenticationBackoffAndAudit": "PASS"
  }
}
JSON
