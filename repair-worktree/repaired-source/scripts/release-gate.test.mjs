import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyReleaseGate } from "./verify-release-gate.mjs";

const evidencePaths = [
  "evidence/01_DYNAMIC_PROFILE_FIXTURE_REDACTED.json",
  "evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json",
  "evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json",
  "evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json",
  "evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json",
  "evidence/07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json",
];

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(releaseStatus) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-gate-test-"));
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await mkdir(path.join(root, "evidence"), { recursive: true });
  const provenance = "{}\n";
  const lock = "{}\n";
  await writeFile(path.join(root, "SOURCE_PROVENANCE.json"), provenance);
  await writeFile(path.join(root, "bridge/package-lock.json"), lock);
  const requiredEvidenceSha256 = {};
  for (const relative of evidencePaths) {
    const content = `${JSON.stringify({ result: "PASS", relative })}\n`;
    await writeFile(path.join(root, relative), content);
    requiredEvidenceSha256[relative] = digest(content);
  }
  const stable = releaseStatus === "stable";
  const status = {
    schemaVersion: 2,
    version: "0.6.5",
    releaseStatus,
    controlledUseAllowed: stable,
    deliverableStatus: stable ? "DELIVERABLE_PASS" : "REPAIR_IN_PROGRESS",
    gates: { security: stable ? "PASS" : "IN_PROGRESS" },
    artifactBindings: {
      sourceProvenanceSha256: digest(provenance),
      packageLockSha256: digest(lock),
      requiredEvidenceSha256,
    },
  };
  await writeFile(path.join(root, "release-status.json"), `${JSON.stringify(status)}\n`);
  return { root, status };
}

test("withdrawn releases are rejected even with audit acknowledgement", async () => {
  const { root } = await fixture("withdrawn");
  await assert.rejects(verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: false }), /never installable/u);
});

test("candidate releases require explicit audit acknowledgement", async () => {
  const { root } = await fixture("candidate");
  await assert.rejects(verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false }), /--audit-candidate/u);
  assert.equal((await verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: true })).installMode, "audit-only");
});

test("stable releases reject skipped tests and require current evidence bindings", async () => {
  const { root } = await fixture("stable");
  await assert.rejects(verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: true }), /cannot skip/u);
  assert.equal((await verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false })).evidenceBindings, 6);
  await writeFile(path.join(root, evidencePaths[0]), "tampered\n");
  await assert.rejects(verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false }), /SHA-256 mismatch/u);
});
