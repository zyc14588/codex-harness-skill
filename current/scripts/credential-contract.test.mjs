#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const releaseGate = await readFile(new URL("verify-release-gate.mjs", import.meta.url), "utf8");
const providerCredential = await readFile(path.join(repositoryRoot, "current/bridge/src/provider-credential.ts"), "utf8");
const credentialRevocation = await readFile(path.join(repositoryRoot, "current/bridge/src/credential-revocation.ts"), "utf8");

function stepIndex(name) {
  const index = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(index, -1, `missing workflow step: ${name}`);
  return index;
}

function stepBlock(name) {
  const start = stepIndex(name);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

test("workflow no longer references DEEPSEEK_API_KEY_EXPIRES_AT", () => {
  assert.equal(workflow.includes("DEEPSEEK_API_KEY_EXPIRES_AT"), false);
});

test("workflow makes no Provider key TTL claim", () => {
  assert.doesNotMatch(workflow, /Provider credential expiry|2-60 minutes in the future|provider[- ]enforced TTL/iu);
});

test("protected Provider job still requires an ephemeral runner", () => {
  assert.match(workflow, /runs-on: \[self-hosted, linux, codex-harness-provider, ephemeral\]/u);
  assert.match(workflow, /RUNNER_EPHEMERAL: \$\{\{ vars\.RUNNER_EPHEMERAL \}\}/u);
  assert.match(workflow, /test "\$RUNNER_EPHEMERAL" = true/u);
});

test("protected credential remains on tmpfs", () => {
  assert.match(workflow, /findmnt -n -o FSTYPE \/dev\/shm/u);
  assert.match(workflow, /CREDENTIAL_FILE: \/dev\/shm\/codex-harness-/u);
});

test("protected credential file mode remains 0600", () => {
  assert.match(workflow, /stat -c '%a'.*= 600/u);
  assert.match(workflow, /umask 077/u);
});

test("credential cleanup overwrites and removes material on every failure path", () => {
  const cleanup = stepBlock("Remove protected credential material");
  assert.match(cleanup, /if: always\(\)/u);
  assert.match(cleanup, /\/dev\/shm\/codex-harness-/u);
  assert.match(cleanup, /dd if=\/dev\/zero/u);
  assert.match(cleanup, /rm -f "\$CREDENTIAL_FILE"/u);
});

test("smoke and authenticated revocation probe are pinned to official DeepSeek", () => {
  const smoke = stepBlock("Current-revision Flash and Pro smoke");
  const revocation = stepBlock("Verify provider-side credential revocation");
  assert.match(smoke, /CODEX_REAL_SMOKE_PROVIDER_BASE_URL: https:\/\/api\.deepseek\.com/u);
  assert.match(smoke, /DEEPSEEK_BASE_URL: https:\/\/api\.deepseek\.com/u);
  assert.match(revocation, /DEEPSEEK_BASE_URL: https:\/\/api\.deepseek\.com/u);
  assert.match(workflow, /https:\/\/api\.deepseek\.com\/models/u);
  assert.doesNotMatch(smoke, /\$\{\{ vars\.DEEPSEEK_BASE_URL/u);
  assert.match(providerCredential, /OFFICIAL_DEEPSEEK_BASE_URL = "https:\/\/api\.deepseek\.com"/u);
  assert.match(credentialRevocation, /probeOfficialDeepSeekCredential\(credential\.value/u);
});

test("revocation polling accepts only 401 and 403", () => {
  assert.match(providerCredential, /REVOCATION_ACCEPTED_STATUSES = Object\.freeze\(\[401, 403\]/u);
  assert.match(workflow, /revocationHttpStatus.*\[401,403\]/u);
  assert.match(workflow, /acceptedStatuses.*\[401,403\]/u);
});

test("revocation polling uses the fixed 900-second and 15-second bounds", () => {
  assert.match(providerCredential, /REVOCATION_MAX_WAIT_SECONDS = 900/u);
  assert.match(providerCredential, /REVOCATION_POLL_INTERVAL_SECONDS = 15/u);
  assert.match(workflow, /maxWaitSeconds'\)!=900/u);
  assert.match(workflow, /pollIntervalSeconds'\)!=15/u);
  assert.match(providerCredential, /FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED/u);
});

test("revocation probe discards the response body", () => {
  assert.match(providerCredential, /response\.resume\(\)/u);
  assert.doesNotMatch(providerCredential, /response\.on\(["']data["']/u);
  assert.match(workflow, /responseBodyCaptured'\) is not False/u);
});

test("credential fingerprint is SHA-256 cross-bound across every artifact member", () => {
  assert.match(providerCredential, /createHash\("sha256"\)\.update\(rawBytes\)\.digest\("hex"\)/u);
  assert.match(workflow, /credentialFingerprintSha256/u);
  assert.match(workflow, /credential_fingerprint=hashlib\.sha256\(credential\)\.hexdigest\(\)/u);
  assert.match(workflow, /revocationEvidenceSha256/u);
  assert.match(workflow, /providerEvidenceSha256/u);
});

test("credential raw bytes are rejected from every artifact JSON", () => {
  assert.match(workflow, /credential in raw or credential in revocation_raw/u);
  assert.match(workflow, /credential in binding_raw/u);
  assert.doesNotMatch(credentialRevocation, /JSON\.stringify\(credential/u);
});

test("artifact construction and attestation occur only after revocation PASS", () => {
  const revocation = stepIndex("Verify provider-side credential revocation");
  const build = stepIndex("Build deterministic redacted Provider evidence subject");
  const upload = stepIndex("Upload immutable Provider evidence subject");
  assert.ok(revocation < build && build < upload);
  const buildBlock = stepBlock("Build deterministic redacted Provider evidence subject");
  for (const member of ["provider-smoke.json", "run-binding.json", "credential-revocation.json"]) {
    assert.match(buildBlock, new RegExp(member.replace(".", "\\."), "u"));
  }
});

test("OIDC attestation and cryptographic verification cover the final revocation-bearing tar", () => {
  const upload = stepIndex("Upload immutable Provider evidence subject");
  const attest = stepIndex("Attest Provider evidence subject with GitHub OIDC");
  const verify = stepIndex("Cryptographically verify GitHub/Sigstore attestation");
  assert.ok(upload < attest && attest < verify);
  assert.match(stepBlock("Attest Provider evidence subject with GitHub OIDC"), /subject-path: \$\{\{ runner\.temp \}\}\/codex-harness-provider-evidence-\$\{\{ github\.sha \}\}\.tar/u);
  assert.match(releaseGate, /expectedMembers = \["credential-revocation\.json", "provider-smoke\.json", "run-binding\.json"\]/u);
});

test("release and seal gates name revocation, secret-removal, and runner lifecycle blockers", () => {
  assert.match(releaseGate, /BLOCKED_PROVIDER_CREDENTIAL_REVOCATION_EVIDENCE/u);
  assert.match(releaseGate, /PROVIDER_ENVIRONMENT_SECRET_REMOVAL_REQUIRED/u);
  assert.match(releaseGate, /PROVIDER_EPHEMERAL_RUNNER_DEREGISTRATION_REQUIRED/u);
  assert.match(releaseGate, /DEDICATED_DISPOSABLE_MANUAL_REVOKE_VERIFIED/u);
});
