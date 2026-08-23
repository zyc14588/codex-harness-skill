import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANDIDATE_VERSION,
  CRITICAL_PATHS,
  STABLE_VERSION,
  releaseIntegrity,
} from "./release-integrity.mjs";
import { verifyReleaseGate } from "./verify-release-gate.mjs";

const implementation = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  committedAt: "2026-08-24T00:00:00.000Z",
};
const evidencePaths = {
  local: "evidence/01_CURRENT_REVISION_LOCAL_QUALIFICATION.json",
  real: "evidence/02_CURRENT_REVISION_REAL_PROVIDER_REDACTED.json",
  negative: "evidence/03_CURRENT_REVISION_NEGATIVE_SMOKE.json",
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function writeRelative(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeSourceFixture(root, version) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  await writeRelative(root, ".agents/plugins/marketplace.json", json({}));
  await writeRelative(root, ".codex-plugin/plugin.json", json({ name: "fixture", version }));
  await writeRelative(root, ".mcp.json", json({}));
  await writeRelative(root, "LICENSE", "fixture license\n");
  await writeRelative(root, "README.md", `# Codex ↔ DeepSeek Harness Bridge ${version}\n`);
  await writeRelative(root, "bridge/package.json", json({ name: "fixture", version }));
  await writeRelative(root, "bridge/package-lock.json", json({
    name: "fixture",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version } },
  }));
  await writeRelative(root, "bridge/tsconfig.json", json({}));
  await writeRelative(root, "bridge/dist/index.js", "// deterministic fixture build\n");
  for (const relative of CRITICAL_PATHS) await writeRelative(root, relative, `// ${relative}\n`);
  await writeRelative(root, "bridge/src/monitor-daemon.ts", `const VERSION = "${version}";\n`);
  await writeRelative(root, "bridge/src/index.ts", `const serverInfo = { version: "${version}" };\n`);
  await writeRelative(root, "bridge/src/stdio-client.ts", `const clientInfo = { version: "${version}" };\n`);
  await writeRelative(root, "bridge/src/acceptance-client.ts", `const proof = { serverVersion: "${version}" };\n`);
  await writeRelative(root, "bridge/src/monitor.ts", `const snapshot = { serviceVersion: "${version}" };\n`);
  await writeRelative(root, "bridge/src/direct-acceptance.ts", `const report = { version: "${version}" };\n`);
  await writeRelative(root, "config/config.example.json", json({
    pinnedHarnessCommit: "c".repeat(40),
    pinnedHarnessBuildSha256: "d".repeat(64),
  }));
  await writeRelative(root, "docs/fixture.md", `qualification fixture ${version}\n`);
  await writeRelative(root, "harness/minimal/MANAGED_MARKER.json", json({ managedBy: "fixture", version }));
  await writeRelative(root, "schemas/fixture.json", json({}));
  await writeRelative(root, "scripts/install.sh", `VERSION="${version}"\n`);
  await writeRelative(root, "scripts/render-minimal-harness.py", `VERSION = "${version}"\n`);
  await writeRelative(root, "skills/codex-harness/SKILL.md", `# Codex-Harness ${version} fixture\n`);
}

function qualifiedLeaf(model, targetPath) {
  const fingerprint = model === "deepseek-v4-flash" ? "1".repeat(64) : "2".repeat(64);
  const commit = model === "deepseek-v4-flash" ? "3".repeat(40) : "4".repeat(40);
  return {
    model,
    status: "completed",
    changedPaths: [targetPath],
    outOfScopePaths: [],
    reviewedPaths: [targetPath],
    reviewDecision: "approved",
    verificationPassed: true,
    verificationCleanStart: true,
    verificationWorktreeRemoved: true,
    reviewedPatchSha256: "5".repeat(64),
    verificationResultFingerprint: "6".repeat(64),
    reviewedFingerprint: fingerprint,
    currentFingerprint: fingerprint,
    verifiedFingerprint: fingerprint,
    bridgeCommit: commit,
    localCommit: commit,
    worktreeRemoved: true,
    branchDeleted: true,
    usage: {
      apiCalls: model === "deepseek-v4-flash" ? 4 : 3,
      completedCalls: model === "deepseek-v4-flash" ? 4 : 3,
      failedCalls: 0,
      inputTokens: 100,
      outputTokens: 20,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
    },
  };
}

function evidenceBase(integrity) {
  return {
    generatedAt: "2026-08-24T00:01:00.000Z",
    sourceCommit: implementation.commit,
    sourceTree: implementation.tree,
    sourceTreeSha256: integrity.source.sha256,
    criticalSetSha256: integrity.critical.setSha256,
  };
}

function smokeEvidence(integrity) {
  return {
    ...evidenceBase(integrity),
    result: "PASS",
    version: STABLE_VERSION,
    currentRevision: true,
    flash: {
      ...qualifiedLeaf("deepseek-v4-flash", "real-flash-multiturn.txt"),
      requestCount: 4,
      toolProtocolNativeCallCount: 2,
      thinkingRequestEvidence: Array.from({ length: 4 }, (_value, index) => ({
        requestOrdinal: index + 1,
        thinkingType: "disabled",
        toolChoicePresent: false,
        replayRequirementCount: 0,
      })),
    },
    pro: {
      ...qualifiedLeaf("deepseek-v4-pro", "real-pro-thinking.txt"),
      requestCount: 3,
      thinkingRequestEvidence: Array.from({ length: 3 }, (_value, index) => ({
        requestOrdinal: index + 1,
        thinkingType: "enabled",
        reasoningEffort: "high",
        toolChoicePresent: false,
        replayRequirementCount: index,
      })),
    },
  };
}

async function candidateFixture(version = CANDIDATE_VERSION) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-gate-candidate-"));
  await writeSourceFixture(root, version);
  await writeRelative(root, "release-status.json", `${JSON.stringify({
    schemaVersion: 3,
    version,
    releaseStatus: "candidate",
    ...(version === STABLE_VERSION ? { qualificationStage: "FINAL_VERSION_CURRENT_REVISION_QUALIFICATION" } : {}),
    controlledUseAllowed: false,
    deliverableStatus: "AUDIT_REPAIR_IN_PROGRESS",
    realProviderSmoke: "pending",
  }, null, 2)}\n`);
  return root;
}

async function stableFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-gate-stable-"));
  await writeSourceFixture(root, STABLE_VERSION);
  const provenance = {
    schemaVersion: 3,
    repairLine: {
      implementationCommit: implementation.commit,
      implementationTree: implementation.tree,
    },
  };
  await writeRelative(root, "SOURCE_PROVENANCE.json", `${JSON.stringify(provenance, null, 2)}\n`);
  const integrity = await releaseIntegrity(root);
  const evidence = {
    [evidencePaths.local]: { ...evidenceBase(integrity), result: "PASS", qualification: "local" },
    [evidencePaths.real]: smokeEvidence(integrity),
    [evidencePaths.negative]: { ...evidenceBase(integrity), result: "PASS", qualification: "negative-smoke" },
  };
  const requiredEvidenceSha256 = {};
  for (const [relative, value] of Object.entries(evidence)) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await writeRelative(root, relative, content);
    requiredEvidenceSha256[relative] = digest(content);
  }
  const status = {
    schemaVersion: 3,
    version: STABLE_VERSION,
    releaseStatus: "stable",
    controlledUseAllowed: true,
    deliverableStatus: "DELIVERABLE_PASS",
    realProviderSmoke: "pass",
    implementation,
    gates: {
      localQualification: "PASS",
      negativeSmoke: "PASS",
      currentRevisionRealProvider: "PASS",
    },
    realProviderEvidencePath: evidencePaths.real,
    negativeSmokeEvidencePath: evidencePaths.negative,
    artifactBindings: {
      sourceTreeSha256: integrity.source.sha256,
      packageLockSha256: digest(await readFile(path.join(root, "bridge/package-lock.json"))),
      sourceProvenanceSha256: digest(await readFile(path.join(root, "SOURCE_PROVENANCE.json"))),
      criticalPathSha256: integrity.critical.entries,
      criticalSetSha256: integrity.critical.setSha256,
      harness: { commit: "c".repeat(40), buildSha256: "d".repeat(64) },
      requiredEvidenceSha256,
    },
  };
  await writeRelative(root, "release-status.json", `${JSON.stringify(status, null, 2)}\n`);
  return { root, status, evidence };
}

test("withdrawn releases are rejected even with audit acknowledgement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-gate-withdrawn-"));
  await writeRelative(root, "release-status.json", '{"releaseStatus":"withdrawn"}\n');
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: false, requireArchive: false }),
    /never installable/u,
  );
});

test("candidate releases require explicit audit acknowledgement and forbid stable claims", async () => {
  const root = await candidateFixture();
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: false }),
    /--audit-candidate/u,
  );
  assert.equal((await verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: true, requireArchive: false })).installMode, "audit-only");
  const statusPath = path.join(root, "release-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.deliverableStatus = "DELIVERABLE_PASS";
  await writeFile(statusPath, `${JSON.stringify(status)}\n`);
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: false, requireArchive: false }),
    /forbidden stable/u,
  );
});

test("0.6.6 can remain non-installable while exact-revision qualification is in progress", async () => {
  const root = await candidateFixture(STABLE_VERSION);
  const result = await verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: false, requireArchive: false });
  assert.equal(result.releaseStatus, "candidate");
  const statusPath = path.join(root, "release-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  delete status.qualificationStage;
  await writeFile(statusPath, `${JSON.stringify(status)}\n`);
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: true, skipSelfTests: false, requireArchive: false }),
    /qualification stage/u,
  );
});

test("stable releases require self-tests and current bound evidence", async () => {
  const { root } = await stableFixture();
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: true, requireArchive: false }),
    /cannot skip/u,
  );
  assert.equal(
    (await verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: false })).evidenceBindings,
    3,
  );
  await writeFile(path.join(root, evidencePaths.local), "tampered\n");
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: false }),
    /SHA-256 mismatch/u,
  );
});

test("stable releases reject source changes and evidence predating implementation", async () => {
  const changed = await stableFixture();
  await writeFile(path.join(changed.root, CRITICAL_PATHS[0]), "// changed after qualification\n");
  await assert.rejects(
    verifyReleaseGate({ root: changed.root, auditCandidate: false, skipSelfTests: false, requireArchive: false }),
    /source-tree SHA-256 mismatch/u,
  );

  const stale = await stableFixture();
  const statusPath = path.join(stale.root, "release-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const evidencePath = path.join(stale.root, evidencePaths.negative);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.generatedAt = implementation.committedAt;
  const content = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, content);
  status.artifactBindings.requiredEvidenceSha256[evidencePaths.negative] = digest(content);
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  await assert.rejects(
    verifyReleaseGate({ root: stale.root, auditCandidate: false, skipSelfTests: false, requireArchive: false }),
    /evidence predates/u,
  );
});

test("final archive validation binds the exact name, SHA sidecar, and validation JSON", async () => {
  const { root, status } = await stableFixture();
  const archiveName = "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip";
  status.finalArchive = { name: archiveName };
  await writeFile(path.join(root, "release-status.json"), `${JSON.stringify(status, null, 2)}\n`);
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: true }),
    /requires --archive/u,
  );
  const archive = path.join(root, archiveName);
  const sidecar = `${archive}.sha256`;
  const validation = `${archive}.validation.json`;
  await writeFile(archive, "deterministic fixture archive\n");
  const archiveSha256 = digest(await readFile(archive));
  await writeFile(sidecar, `${archiveSha256}  ${archiveName}\n`);
  await writeFile(validation, `${JSON.stringify({ result: "PASS", archive: archiveName, archiveSha256 })}\n`);
  const result = await verifyReleaseGate({
    root,
    auditCandidate: false,
    skipSelfTests: false,
    requireArchive: true,
    archive,
    sidecar,
    validation,
  });
  assert.equal(result.archiveValidated, true);
  await writeFile(sidecar, `${"0".repeat(64)}  ${archiveName}\n`);
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: true, archive, sidecar, validation }),
    /sidecar does not bind/u,
  );
});
