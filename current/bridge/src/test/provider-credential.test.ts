import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CREDENTIAL_POLICY,
  CredentialRevocationNotObservedError,
  OFFICIAL_DEEPSEEK_MODELS_ENDPOINT,
  credentialFingerprintSha256,
  isCredentialRevocationStatus,
  waitForCredentialRevocation,
} from "../provider-credential.js";

const binding = {
  repository: "zyc14588/codex-harness-skill",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  runId: 123,
  runAttempt: 1,
};

test("credential fingerprint is lowercase SHA-256 of the exact key bytes", () => {
  const raw = Buffer.from("disposable-provider-key-raw-bytes-001", "utf8");
  assert.equal(credentialFingerprintSha256(raw), createHash("sha256").update(raw).digest("hex"));
  assert.match(credentialFingerprintSha256(raw), /^[0-9a-f]{64}$/u);
});

test("only HTTP 401 and 403 prove Provider credential revocation", () => {
  assert.equal(isCredentialRevocationStatus(401), true);
  assert.equal(isCredentialRevocationStatus(403), true);
  for (const status of [0, 200, 204, 400, 404, 408, 429, 500, 502, 503, 599]) {
    assert.equal(isCredentialRevocationStatus(status), false, `HTTP ${status} must not prove revocation`);
  }
});

test("HTTP 200 keeps polling and HTTP 401 produces a cross-bound body-free proof", async () => {
  let nowMs = Date.parse("2026-08-27T00:00:00.000Z");
  const statuses = [200, 401];
  const attempts: Array<{ httpStatus: number; attempt: number; timestamp: string }> = [];
  const fingerprint = "c".repeat(64);
  const evidence = await waitForCredentialRevocation({
    ...binding,
    credentialFingerprintSha256: fingerprint,
    maxWaitSeconds: 30,
    pollIntervalSeconds: 15,
    now: () => nowMs,
    delay: async (milliseconds) => { nowMs += milliseconds; },
    probe: async () => statuses.shift() ?? 0,
    onAttempt: (record) => attempts.push(record),
  });
  assert.deepEqual(attempts.map((entry) => entry.httpStatus), [200, 401]);
  assert.equal(evidence.result, "PASS");
  assert.equal(evidence.credentialPolicy, CREDENTIAL_POLICY);
  assert.equal(evidence.credentialFingerprintSha256, fingerprint);
  assert.equal(evidence.endpoint, OFFICIAL_DEEPSEEK_MODELS_ENDPOINT);
  assert.equal(evidence.revocationHttpStatus, 401);
  assert.deepEqual(evidence.acceptedStatuses, [401, 403]);
  assert.equal(evidence.probeAttempts, 2);
  assert.equal(evidence.responseBodyCaptured, false);
});

test("HTTP 403 independently produces revocation PASS", async () => {
  const evidence = await waitForCredentialRevocation({
    ...binding,
    credentialFingerprintSha256: "d".repeat(64),
    probe: async () => 403,
  });
  assert.equal(evidence.revocationHttpStatus, 403);
  assert.equal(evidence.result, "PASS");
});

test("HTTP 429, 5xx, and other statuses time out fail closed", async () => {
  let nowMs = 0;
  const statuses = [429, 500, 418, 0];
  await assert.rejects(
    waitForCredentialRevocation({
      ...binding,
      credentialFingerprintSha256: "e".repeat(64),
      maxWaitSeconds: 4,
      pollIntervalSeconds: 1,
      now: () => nowMs,
      delay: async (milliseconds) => { nowMs += milliseconds; },
      probe: async () => statuses.shift() ?? 0,
    }),
    (error: unknown) => error instanceof CredentialRevocationNotObservedError
      && error.message === "FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED",
  );
});

test("network errors are not revocation proof and time out fail closed", async () => {
  let nowMs = 0;
  await assert.rejects(
    waitForCredentialRevocation({
      ...binding,
      credentialFingerprintSha256: "f".repeat(64),
      maxWaitSeconds: 2,
      pollIntervalSeconds: 1,
      now: () => nowMs,
      delay: async (milliseconds) => { nowMs += milliseconds; },
      probe: async () => { throw new Error("synthetic network failure"); },
    }),
    (error: unknown) => error instanceof CredentialRevocationNotObservedError
      && error.message === "FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED",
  );
});

test("credential raw bytes never appear in generated revocation evidence", async () => {
  const raw = Buffer.from("dedicated-disposable-secret-key-002", "utf8");
  const evidence = await waitForCredentialRevocation({
    ...binding,
    credentialFingerprintSha256: credentialFingerprintSha256(raw),
    probe: async () => 401,
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(raw.toString("utf8")), false);
  assert.equal(serialized.includes(credentialFingerprintSha256(raw)), true);
});
