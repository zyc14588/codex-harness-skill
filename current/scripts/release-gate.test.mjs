import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  CANDIDATE_VERSION,
  CRITICAL_PATHS,
  STABLE_VERSION,
  gitIdentity,
  implementationScopeBinding,
  releaseIntegrity,
} from "./release-integrity.mjs";
import {
  REQUIRED_ARCHIVE_CHECKS,
  REQUIRED_STABLE_SOURCE_GATES,
  verifyReleaseGate,
} from "./verify-release-gate.mjs";

const implementation = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  committedAt: "2026-08-24T00:00:00.000Z",
};
const evidencePaths = {
  local: "evidence/01_CURRENT_REVISION_LOCAL_QUALIFICATION.json",
  real: "evidence/02_CURRENT_REVISION_REAL_PROVIDER_REDACTED.json",
  negative: "evidence/03_CURRENT_REVISION_NEGATIVE_SMOKE.json",
  external: "evidence/04_GITHUB_EXTERNAL_GATES_2026-08-24.json",
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
    harnessIsolation: {
      resourceProfile: {
        enforcement: "required",
        memoryMaxBytes: 4_294_967_296,
        cpuQuotaPercent: 200,
        tasksMax: 256,
        ioWeight: 100,
        worktreeMaxBytes: 4_294_967_296,
        rlimitNoFile: 4_096,
        rlimitNproc: 4_096,
        rlimitFsizeBytes: 1_073_741_824,
        commandTimeoutSeconds: 1_800,
      },
    },
  }));
  const profile = {
    memoryMaxBytes: 4_294_967_296,
    cpuQuotaPercent: 200,
    tasksMax: 256,
    ioWeight: 100,
    worktreeMaxBytes: 4_294_967_296,
    rlimitNoFile: 4_096,
    rlimitNproc: 4_096,
    rlimitFsizeBytes: 1_073_741_824,
    commandTimeoutSeconds: 1_800,
  };
  await writeRelative(root, "docs/OWNER_DECISIONS.json", json({
    schemaVersion: 1,
    version: STABLE_VERSION,
    decisions: {
      "DEC-001": { status: "APPROVED", selected: "A", options: ["A"], decidedBy: "fixture-owner", decidedAt: "2026-08-24T00:00:01.000Z" },
      "DEC-002": { status: "APPROVED", selected: "A", options: ["A", "B"], implementationVerified: true, decidedBy: "fixture-owner", decidedAt: "2026-08-24T00:00:01.000Z" },
      "DEC-003": { status: "APPROVED", selected: "A", options: ["A", "B"], approvedProfile: profile, decidedBy: "fixture-owner", decidedAt: "2026-08-24T00:00:01.000Z" },
      "DEC-004": { status: "APPROVED", selected: "A", options: ["A", "B"], decidedBy: "fixture-owner", decidedAt: "2026-08-24T00:00:01.000Z" },
    },
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

function externalEvidence(releaseTarget) {
  return {
    schemaVersion: 3,
    result: "PASS",
    generatedAt: "2026-08-24T00:02:00.000Z",
    repository: releaseTarget.repository,
    targetBranch: releaseTarget.branch,
    targetCommit: releaseTarget.sealCommit,
    targetTree: releaseTarget.sealTree,
    workflow: releaseTarget.workflow,
    actionsRun: {
      runId: 12345,
      runAttempt: 1,
      headSha: releaseTarget.sealCommit,
      workflowRef: `${releaseTarget.repository}/.github/workflows/ci.yml@refs/heads/${releaseTarget.branch}`,
      status: "completed",
      conclusion: "success",
      strictLocalGates: { jobId: 12346, conclusion: "success" },
      protectedRealProviderSmoke: {
        jobId: 12347,
        conclusion: "success",
        environment: "deepseek-provider-smoke",
        artifact: {
          id: 12348,
          name: `codex-harness-provider-evidence-${releaseTarget.sealCommit}.tar`,
          url: `https://github.com/${releaseTarget.repository}/actions/runs/12345/artifacts/12348`,
          sha256: "e".repeat(64),
          attestation: {
            type: "github-artifact-attestation",
            verified: true,
            id: 12349,
            url: `https://github.com/${releaseTarget.repository}/attestations/12349`,
            repository: releaseTarget.repository,
            workflowRef: `${releaseTarget.repository}/.github/workflows/ci.yml@refs/heads/${releaseTarget.branch}`,
            subjectSha256: "e".repeat(64),
          },
        },
      },
    },
    branchProtection: {
      status: "PASS",
      httpStatus: 200,
      requiredChecksConfigured: true,
      strictLocalGatesRequired: true,
      protectedProviderSmokeRequired: true,
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
  const releaseTarget = {
    repository: "zyc14588/codex-harness-skill",
    branch: "repair/0.6.6-pre-release-audit-r1",
    sealCommit: "7".repeat(40),
    sealTree: "8".repeat(40),
    workflow: {
      path: ".github/workflows/ci.yml",
      sha256: "9".repeat(64),
    },
  };
  const evidence = {
    [evidencePaths.local]: { ...evidenceBase(integrity), result: "PASS", qualification: "local" },
    [evidencePaths.real]: smokeEvidence(integrity),
    [evidencePaths.negative]: { ...evidenceBase(integrity), result: "PASS", qualification: "negative-smoke" },
    [evidencePaths.external]: externalEvidence(releaseTarget),
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
    releaseTarget,
    gates: Object.fromEntries(REQUIRED_STABLE_SOURCE_GATES.map((key) => [key, "PASS"])),
    localQualificationEvidencePath: evidencePaths.local,
    realProviderEvidencePath: evidencePaths.real,
    negativeSmokeEvidencePath: evidencePaths.negative,
    externalGateEvidencePath: evidencePaths.external,
    artifactBindings: {
      sourceTreeSha256: integrity.source.sha256,
      packageLockSha256: digest(await readFile(path.join(root, "bridge/package-lock.json"))),
      sourceProvenanceSha256: digest(await readFile(path.join(root, "SOURCE_PROVENANCE.json"))),
      criticalPathSha256: integrity.critical.entries,
      criticalSetSha256: integrity.critical.setSha256,
      harness: { commit: "c".repeat(40), buildSha256: "d".repeat(64) },
      requiredEvidenceSha256,
      observationalEvidenceSha256: {},
    },
    finalArchive: { name: "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip" },
  };
  const packageOrigin = {
    schemaVersion: 1,
    kind: "codex-harness-stable-package-origin",
    version: STABLE_VERSION,
    releaseStatus: "stable",
    repository: releaseTarget.repository,
    branch: releaseTarget.branch,
    sealCommit: releaseTarget.sealCommit,
    sealTree: releaseTarget.sealTree,
    implementationCommit: implementation.commit,
    implementationTree: implementation.tree,
    sourceTreeSha256: integrity.source.sha256,
    workflowSha256: releaseTarget.workflow.sha256,
    archiveName: "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip",
  };
  await writeRelative(root, "package-origin.json", `${JSON.stringify(packageOrigin, null, 2)}\n`);
  await writeRelative(root, "release-status.json", `${JSON.stringify(status, null, 2)}\n`);
  return { root, status, evidence, packageOrigin };
}

async function rewriteStatus(root, mutate) {
  const target = path.join(root, "release-status.json");
  const status = JSON.parse(await readFile(target, "utf8"));
  mutate(status);
  await writeFile(target, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

async function rewriteBoundEvidence(root, relative, mutate) {
  const target = path.join(root, relative);
  const evidence = JSON.parse(await readFile(target, "utf8"));
  mutate(evidence);
  const content = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(target, content);
  await rewriteStatus(root, (status) => {
    status.artifactBindings.requiredEvidenceSha256[relative] = digest(content);
  });
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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
    (await verifyReleaseGate({ root, auditCandidate: false, auditPackageStaging: true, skipSelfTests: false, requireArchive: false })).evidenceBindings,
    4,
  );
  await writeFile(path.join(root, evidencePaths.local), "tampered\n");
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /SHA-256 mismatch/u,
  );
});

test("stable source gates are an exact fail-closed set", async () => {
  const fixture = await stableFixture();
  for (const key of REQUIRED_STABLE_SOURCE_GATES) {
    await rewriteStatus(fixture.root, (status) => { delete status.gates[key]; });
    await assert.rejects(
      verifyReleaseGate({ root: fixture.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
      /keys must exactly equal/u,
      `missing required gate ${key} must fail`,
    );
    await rewriteStatus(fixture.root, (status) => { status.gates[key] = "PASS"; });
  }
  await rewriteStatus(fixture.root, (status) => { status.gates.unknownGate = "PASS"; });
  await assert.rejects(
    verifyReleaseGate({ root: fixture.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /keys must exactly equal/u,
  );
  await rewriteStatus(fixture.root, (status) => { delete status.gates.unknownGate; status.gates.branchProtectionRequiredChecks = "BLOCKED"; });
  await assert.rejects(
    verifyReleaseGate({ root: fixture.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /must be exactly PASS/u,
  );
});

test("GitHub evidence is required, exact-tip bound, protected, and non-observational", async () => {
  const missingProtection = await stableFixture();
  await rewriteBoundEvidence(missingProtection.root, evidencePaths.external, (evidence) => { delete evidence.branchProtection; });
  await assert.rejects(
    verifyReleaseGate({ root: missingProtection.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /branch protection/u,
  );

  const observational = await stableFixture();
  await rewriteStatus(observational.root, (status) => {
    status.artifactBindings.observationalEvidenceSha256[evidencePaths.external]
      = status.artifactBindings.requiredEvidenceSha256[evidencePaths.external];
  });
  await assert.rejects(
    verifyReleaseGate({ root: observational.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /cannot be observational/u,
  );

  const wrongHead = await stableFixture();
  await rewriteBoundEvidence(wrongHead.root, evidencePaths.external, (evidence) => { evidence.actionsRun.headSha = "f".repeat(40); });
  await assert.rejects(
    verifyReleaseGate({ root: wrongHead.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /exact seal head/u,
  );

  const wrongWorkflow = await stableFixture();
  await rewriteBoundEvidence(wrongWorkflow.root, evidencePaths.external, (evidence) => { evidence.workflow.sha256 = "0".repeat(64); });
  await assert.rejects(
    verifyReleaseGate({ root: wrongWorkflow.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /workflow path\/SHA-256 mismatch/u,
  );

  const skipped = await stableFixture();
  await rewriteBoundEvidence(skipped.root, evidencePaths.external, (evidence) => { evidence.actionsRun.protectedRealProviderSmoke.conclusion = "skipped"; });
  await assert.rejects(
    verifyReleaseGate({ root: skipped.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /was skipped/u,
  );
});

test("stable package staging requires package-origin and controlled install requires archive", async () => {
  const missingOrigin = await stableFixture();
  await unlink(path.join(missingOrigin.root, "package-origin.json"));
  await assert.rejects(
    verifyReleaseGate({ root: missingOrigin.root, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /package-origin/u,
  );
  const missingArchive = await stableFixture();
  await assert.rejects(
    verifyReleaseGate({ root: missingArchive.root, skipSelfTests: false, requireArchive: false }),
    /always requires exact external archive validation/u,
  );
});

test("implementation source scope changes are detected byte-for-byte", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-implementation-binding-"));
  await writeSourceFixture(root, STABLE_VERSION);
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.name", "Release Gate Fixture"]);
  runGit(root, ["config", "user.email", "release-gate@example.invalid"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-qm", "implementation"]);
  const implementationCommit = runGit(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, CRITICAL_PATHS[0]), "// changed after implementation\n");
  runGit(root, ["add", CRITICAL_PATHS[0]]);
  runGit(root, ["commit", "-qm", "changed source"]);
  const binding = implementationScopeBinding(root, implementationCommit);
  assert.equal(binding.exact, false);
  assert.deepEqual(binding.changedPaths, [CRITICAL_PATHS[0]]);
});

test("Git identity distinguishes the canonical source subtree from the repository seal tree", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "release-git-tree-binding-"));
  const root = path.join(repository, "current");
  await writeSourceFixture(root, STABLE_VERSION);
  await writeRelative(repository, "root-governance.txt", "repository seal input\n");
  runGit(repository, ["init", "-q"]);
  runGit(repository, ["config", "user.name", "Release Gate Fixture"]);
  runGit(repository, ["config", "user.email", "release-gate@example.invalid"]);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-qm", "nested canonical source"]);
  const identity = gitIdentity(root);
  assert.equal(identity.sourceTree, runGit(repository, ["rev-parse", "HEAD:current"]));
  assert.equal(identity.repositoryTree, runGit(repository, ["rev-parse", "HEAD^{tree}"]));
  assert.notEqual(identity.sourceTree, identity.repositoryTree);
});

test("post-implementation metadata is an exact allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-metadata-binding-"));
  await writeSourceFixture(root, STABLE_VERSION);
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.name", "Release Gate Fixture"]);
  runGit(root, ["config", "user.email", "release-gate@example.invalid"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-qm", "implementation"]);
  const implementationCommit = runGit(root, ["rev-parse", "HEAD"]);
  await writeRelative(root, "release-status.json", "{}\n");
  runGit(root, ["add", "release-status.json"]);
  runGit(root, ["commit", "-qm", "allowed seal metadata"]);
  let binding = implementationScopeBinding(root, implementationCommit);
  assert.equal(binding.exact, true);
  assert.equal(binding.allowedMetadataOnly, true);
  assert.deepEqual(binding.metadataChanges, ["release-status.json"]);

  await writeRelative(root, "unscoped-release-note.txt", "not an allowed seal input\n");
  runGit(root, ["add", "unscoped-release-note.txt"]);
  runGit(root, ["commit", "-qm", "unauthorized seal metadata"]);
  binding = implementationScopeBinding(root, implementationCommit);
  assert.equal(binding.exact, true);
  assert.equal(binding.allowedMetadataOnly, false);
  assert.deepEqual(binding.unauthorizedMetadataChanges, ["unscoped-release-note.txt"]);
});

test("stable releases reject source changes and evidence predating implementation", async () => {
  const changed = await stableFixture();
  await writeFile(path.join(changed.root, CRITICAL_PATHS[0]), "// changed after qualification\n");
  await assert.rejects(
    verifyReleaseGate({ root: changed.root, auditCandidate: false, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
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
    verifyReleaseGate({ root: stale.root, auditCandidate: false, auditPackageStaging: true, skipSelfTests: false, requireArchive: false }),
    /evidence predates/u,
  );
});

test("final archive validation binds the exact name, SHA sidecar, and validation JSON", async () => {
  const { root } = await stableFixture();
  const archiveName = "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip";
  await assert.rejects(
    verifyReleaseGate({ root, auditCandidate: false, skipSelfTests: false, requireArchive: false }),
    /always requires exact external archive validation/u,
  );
  const archive = path.join(root, archiveName);
  const sidecar = `${archive}.sha256`;
  const validation = `${archive}.validation.json`;
  await writeFile(archive, "deterministic fixture archive\n");
  const archiveSha256 = digest(await readFile(archive));
  const packageOriginSha256 = digest(await readFile(path.join(root, "package-origin.json")));
  await writeFile(sidecar, `${archiveSha256}  ${archiveName}\n`);
  const status = JSON.parse(await readFile(path.join(root, "release-status.json"), "utf8"));
  const chainSha256 = digest([
    archiveSha256,
    packageOriginSha256,
    status.releaseTarget.sealCommit,
    status.releaseTarget.sealTree,
    status.implementation.commit,
  ].join("\n"));
  await writeFile(validation, `${JSON.stringify({
    schemaVersion: 2,
    result: "PASS",
    archive: archiveName,
    archiveSha256,
    packageOriginSha256,
    sealCommit: status.releaseTarget.sealCommit,
    sealTree: status.releaseTarget.sealTree,
    implementationCommit: status.implementation.commit,
    checks: Object.fromEntries(REQUIRED_ARCHIVE_CHECKS.map((key) => [key, "PASS"])),
    attestation: { type: "sha256-chain-v1", verified: true, chainSha256 },
  })}\n`);
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
