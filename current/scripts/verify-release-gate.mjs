#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CANDIDATE_VERSION,
  CRITICAL_PATHS,
  STABLE_VERSION,
  implementationScopeBinding,
  releaseIntegrity,
  sha256File,
} from "./release-integrity.mjs";

export const REQUIRED_STABLE_SOURCE_GATES = Object.freeze([
  "branchProtectionRequiredChecks",
  "brokeredToolCancellationNegatives",
  "cleanReviewedPatchVerification",
  "currentRevisionFlashSmoke",
  "currentRevisionProThinkingSmoke",
  "directAcceptance",
  "dynamicManagedProfile",
  "githubActionsExactTip",
  "ignoredPoisoningVerification",
  "modelReadOutputBounds",
  "negativeSmokeSuite",
  "operatorAuditRetention",
  "operatorAuthenticationHardening",
  "processE2E",
  "protectedProviderEvidenceAttestation",
  "providerCapabilityIsolation",
  "reasoningReplayFailureInjection",
  "repositoryHistoryReadBoundaryDecision",
  "resourceControlEnforcement",
  "resourceExhaustionNegatives",
  "securityAcceptance",
  "skillValidation",
  "stdioMcpAcceptance",
  "transactionalPackageAcceptance",
  "unitAndComponentRegression",
].sort());

export const REQUIRED_ARCHIVE_CHECKS = Object.freeze([
  "deterministicDoubleBuild",
  "freshInstallLifecycle",
  "releaseGate",
  "symlinkAndNodeModulesHygiene",
  "unpackedBuildAndTests",
  "unpackedManifest",
  "unpackedPackageAcceptance",
  "unpackedSourceGate",
].sort());

const EXPECTED_ARCHIVE_NAME = "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip";
const EXPECTED_PACKAGE_ORIGIN_KIND = "codex-harness-stable-package-origin";

function usage() {
  process.stderr.write("Usage: verify-release-gate.mjs --root PATH [--audit-candidate|--seal-ready --external-evidence FILE --external-subject FILE|--audit-package-staging] [--skip-self-tests] [--require-archive --archive ZIP --sidecar FILE --validation FILE]\n");
}

function parseArgs(argv) {
  const result = { auditCandidate: false, sealReady: false, auditPackageStaging: false, skipSelfTests: false, requireArchive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--archive", "--sidecar", "--validation", "--external-evidence", "--external-subject"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      result[arg === "--external-evidence" ? "externalEvidence" : arg === "--external-subject" ? "externalSubject" : arg.slice(2)] = path.resolve(value);
    } else if (arg === "--audit-candidate") result.auditCandidate = true;
    else if (arg === "--seal-ready") result.sealReady = true;
    else if (arg === "--audit-package-staging") result.auditPackageStaging = true;
    else if (arg === "--skip-self-tests") result.skipSelfTests = true;
    else if (arg === "--require-archive") result.requireArchive = true;
    else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.root) throw new Error("--root is required");
  if ([result.auditCandidate, result.sealReady, result.auditPackageStaging].filter(Boolean).length > 1) {
    throw new Error("release gate modes are mutually exclusive");
  }
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, required, label) {
  const actual = Object.keys(object(value, label)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} keys must exactly equal the required set; expected=${required.join(",")} actual=${actual.join(",")}`);
  }
}

function sha256(value, label) {
  if (!/^[0-9a-f]{64}$/u.test(String(value ?? ""))) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return String(value);
}

function gitObjectId(value, label) {
  if (!/^[0-9a-f]{40,64}$/u.test(String(value ?? ""))) throw new Error(`${label} must be a Git object id`);
  return String(value);
}

async function jsonFile(target, label) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${target}`);
  return object(JSON.parse(await readFile(target, "utf8")), label);
}

async function boundFile(root, relative, expected, label) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) throw new Error(`${label} path is unsafe: ${relative}`);
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error(`${label} has an invalid SHA-256 binding`);
  const target = path.resolve(root, relative);
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(path.dirname(target));
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${label} resolves outside the release root: ${relative}`);
  }
  const actual = await sha256File(target);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: ${relative}`);
  return target;
}

async function assertVersionSurfaces(root, version) {
  const packageJson = await jsonFile(path.join(root, "bridge/package.json"), "bridge/package.json");
  const packageLock = await jsonFile(path.join(root, "bridge/package-lock.json"), "bridge/package-lock.json");
  const plugin = await jsonFile(path.join(root, ".codex-plugin/plugin.json"), ".codex-plugin/plugin.json");
  const marker = await jsonFile(path.join(root, "harness/minimal/MANAGED_MARKER.json"), "managed marker");
  if (packageJson.version !== version || packageLock.version !== version || packageLock.packages?.[""]?.version !== version
    || plugin.version !== version || marker.version !== version) {
    throw new Error("package/lock/plugin/managed-profile versions are inconsistent");
  }
  const textSurfaces = [
    ["scripts/install.sh", `VERSION=\"${version}\"`],
    ["scripts/render-minimal-harness.py", `VERSION = \"${version}\"`],
    ["bridge/src/monitor-daemon.ts", `const VERSION = \"${version}\"`],
    ["bridge/src/index.ts", `version: \"${version}\"`],
    ["bridge/src/stdio-client.ts", `version: \"${version}\"`],
    ["bridge/src/acceptance-client.ts", `serverVersion: \"${version}\"`],
    ["bridge/src/monitor.ts", `serviceVersion: \"${version}\"`],
    ["bridge/src/direct-acceptance.ts", `version: \"${version}\"`],
    ["README.md", `# Codex ↔ DeepSeek Harness Bridge ${version}`],
    ["skills/codex-harness/SKILL.md", `# Codex-Harness ${version}`],
  ];
  for (const [relative, expected] of textSurfaces) {
    if (!(await readFile(path.join(root, relative), "utf8")).includes(expected)) throw new Error(`version surface mismatch: ${relative}`);
  }
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Resolve a seal-ready identity without asking a commit to contain its own hash.
 * GitHub qualifies qualificationCommit; the clean checked-out descendant is the
 * metadata-only seal and its identity is derived from Git at verification time.
 */
export function nonCyclicSealReadyBinding(status, integrity) {
  if (status.releaseStatus !== "seal_ready" || !integrity.git?.available) {
    throw new Error("non-cyclic seal binding requires a seal-ready Git checkout");
  }
  const target = object(status.releaseTarget, "release target binding");
  const qualificationCommit = gitObjectId(target.qualificationCommit, "release target qualification commit");
  const qualificationTree = gitObjectId(target.qualificationTree, "release target qualification tree");
  if (target.sealMode !== "current_checked_out_metadata_commit"
    || target.sealCommit !== null || target.sealTree !== null) {
    throw new Error("seal-ready target must derive the seal from the checked-out metadata commit without self-referential seal fields");
  }
  const sealCommit = gitObjectId(integrity.git.commit, "checked-out metadata seal commit");
  const sealTree = gitObjectId(integrity.git.repositoryTree, "checked-out metadata seal tree");
  const ancestry = git(integrity.git.top, ["merge-base", "--is-ancestor", qualificationCommit, sealCommit]);
  if (ancestry.status !== 0) throw new Error("qualification commit is not an ancestor of the checked-out metadata seal");
  const observedQualificationTree = git(integrity.git.top, ["rev-parse", `${qualificationCommit}^{tree}`]);
  if (observedQualificationTree.status !== 0 || observedQualificationTree.stdout.trim() !== qualificationTree) {
    throw new Error("qualification commit/tree binding is invalid");
  }
  return { qualificationCommit, qualificationTree, sealCommit, sealTree };
}

function assertSmokeQualification(smoke, status, integrity) {
  if (smoke.result !== "PASS" || smoke.version !== STABLE_VERSION || smoke.currentRevision !== true) {
    throw new Error("current-revision real Provider smoke is not a 0.6.6 PASS");
  }
  const implementation = object(status.implementation, "implementation binding");
  if (smoke.sourceCommit !== implementation.commit || smoke.sourceTree !== implementation.tree
    || smoke.sourceTreeSha256 !== integrity.source.sha256 || smoke.criticalSetSha256 !== integrity.critical.setSha256) {
    throw new Error("real Provider smoke was generated from a different commit/tree/critical path set");
  }
  const flash = object(smoke.flash, "Flash smoke");
  const pro = object(smoke.pro, "Pro smoke");
  if (Number(flash.requestCount) < 4 || Number(flash.toolProtocolNativeCallCount) < 2
    || !Array.isArray(flash.thinkingRequestEvidence)
    || !flash.thinkingRequestEvidence.every((entry) => entry.thinkingType === "disabled" && entry.reasoningEffort === undefined)) {
    throw new Error("Flash smoke does not prove four disabled requests and two native tool calls");
  }
  if (Number(pro.requestCount) < 3 || !Array.isArray(pro.thinkingRequestEvidence)
    || !pro.thinkingRequestEvidence.every((entry, index) => entry.thinkingType === "enabled"
      && entry.reasoningEffort === "high" && entry.toolChoicePresent === false
      && entry.replayRequirementCount === index)) {
    throw new Error("Pro smoke does not prove three enabled/high requests without tool_choice and complete replay depth");
  }
  for (const leaf of [flash, pro]) {
    const usage = object(leaf.usage, `${String(leaf.model)} usage`);
    if (leaf.reviewDecision !== "approved" || leaf.verificationPassed !== true
      || leaf.verificationCleanStart !== true || leaf.verificationWorktreeRemoved !== true
      || leaf.worktreeRemoved !== true || leaf.branchDeleted !== true
      || leaf.reviewedFingerprint !== leaf.currentFingerprint || leaf.currentFingerprint !== leaf.verifiedFingerprint
      || leaf.bridgeCommit !== leaf.localCommit
      || !/^[0-9a-f]{40,64}$/u.test(String(leaf.localCommit ?? ""))
      || !/^[0-9a-f]{64}$/u.test(String(leaf.reviewedPatchSha256 ?? ""))
      || !/^[0-9a-f]{64}$/u.test(String(leaf.verificationResultFingerprint ?? ""))
      || !Array.isArray(leaf.changedPaths) || leaf.changedPaths.length !== 1
      || !Array.isArray(leaf.reviewedPaths) || JSON.stringify(leaf.changedPaths) !== JSON.stringify(leaf.reviewedPaths)
      || !Array.isArray(leaf.outOfScopePaths) || leaf.outOfScopePaths.length !== 0
      || Number(usage.apiCalls) !== Number(leaf.requestCount)
      || Number(usage.completedCalls) !== Number(leaf.requestCount)
      || Number(usage.failedCalls) !== 0
      || Number(usage.inputTokens ?? 0) + Number(usage.estimatedInputTokens ?? 0) <= 0
      || Number(usage.outputTokens ?? 0) + Number(usage.estimatedOutputTokens ?? 0) <= 0) {
      throw new Error("real Provider smoke leaf lacks review/verification/fingerprint/commit/cleanup evidence");
    }
  }
}

function assertStableSourceGates(status) {
  const gates = object(status.gates, "release gates");
  exactKeys(gates, REQUIRED_STABLE_SOURCE_GATES, "release gates");
  if (REQUIRED_STABLE_SOURCE_GATES.some((key) => gates[key] !== "PASS")) {
    throw new Error("every required stable source gate must be exactly PASS");
  }
}

async function assertOwnerDecisions(root, config) {
  const document = await jsonFile(path.join(root, "docs/OWNER_DECISIONS.json"), "owner decisions");
  if (document.schemaVersion !== 2 || document.version !== STABLE_VERSION
    || document.decidedBy !== "zyc14588" || document.decidedAt !== "2026-08-26T01:22:12+10:00") {
    throw new Error("owner decisions schema/version/attribution is invalid");
  }
  const decisions = object(document.decisions, "owner decisions map");
  const required = ["DEC-001", "DEC-002", "DEC-003", "DEC-004"].sort();
  const expectedSelections = {
    "DEC-001": "B_PUBLIC_AFTER_FULL_REPOSITORY_AND_HISTORY_AUDIT",
    "DEC-002": "A_ACCEPT_REPOSITORY_AND_HISTORY_READ_BOUNDARY",
    "DEC-003": "D_TIERED_RESOURCE_PROFILES",
    "DEC-004": "A_USE_COMMIT_SUFFIXED_CANDIDATE_PATH",
  };
  exactKeys(decisions, required, "owner decisions map");
  for (const id of required) {
    const decision = object(decisions[id], `owner decision ${id}`);
    if (decision.status !== "APPROVED" || decision.selected !== expectedSelections[id]
      || !Array.isArray(decision.options) || !decision.options.includes(decision.selected)
      || decision.decidedBy !== document.decidedBy || decision.decidedAt !== document.decidedAt
      || decision.implementationVerified !== true) {
      throw new Error(`owner decision ${id} is not approved, exact, attributable, and implementation-verified`);
    }
  }
  const publicAudit = await jsonFile(path.join(root, "evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json"), "public repository/history audit");
  if (publicAudit.result !== "PASS_PUBLICATION_ELIGIBILITY_AUDIT"
    || !Array.isArray(publicAudit.blockers) || publicAudit.blockers.length !== 0
    || publicAudit.auditPolicy !== "DEC-001-full-repository-and-history-audit-v1") {
    throw new Error("DEC-001/DEC-002 require a complete PASS public repository/history audit");
  }
  const disclosure = await readFile(path.join(root, "docs/REPOSITORY_HISTORY_DISCLOSURE_BOUNDARY_ZH.md"), "utf8");
  if (!disclosure.includes("accepted disclosure boundary") || !disclosure.includes("configured remote model")) {
    throw new Error("DEC-002 disclosure-boundary documentation is incomplete");
  }
  const brokerSource = await readFile(path.join(root, "bridge/src/brokered-tool-host.ts"), "utf8");
  if (!brokerSource.includes("gitHistoryArguments") || !brokerSource.includes("MODEL_VISIBLE_TEXT_MAX_BYTES")) {
    throw new Error("DEC-002 Broker-bound paginated Git history implementation is missing");
  }
  const runtimeProfile = object(config.harnessIsolation, "config Harness isolation").resourceProfile;
  const profile = object(runtimeProfile, "config controlled resource profile");
  if (profile.enforcement !== "required") throw new Error("stable controlled resource profile must use required enforcement");
  const approvedProfiles = object(decisions["DEC-003"].profiles, "approved controlled resource profiles");
  const runtimeProfiles = object(config.harnessIsolation.resourceProfiles, "runtime controlled resource profiles");
  const profileIds = ["local_or_flash_trivial_small", "flash_medium", "pro_large", "authoritative_verification"];
  exactKeys(approvedProfiles, [...profileIds].sort(), "approved controlled resource profiles");
  exactKeys(runtimeProfiles, [...profileIds].sort(), "runtime controlled resource profiles");
  const fields = [
    "memoryMaxBytes", "cpuQuotaPercent", "tasksMax", "ioWeight", "worktreeMaxBytes",
    "rlimitNoFile", "rlimitNproc", "rlimitFsizeBytes", "commandTimeoutSeconds",
  ];
  for (const id of profileIds) {
    const approvedProfile = object(approvedProfiles[id], `approved resource profile ${id}`);
    const runtimeTier = object(runtimeProfiles[id], `runtime resource profile ${id}`);
    if (fields.some((field) => approvedProfile[field] !== runtimeTier[field])) {
      throw new Error(`runtime resource profile ${id} differs from the owner-approved exact matrix`);
    }
  }
  if (fields.some((field) => approvedProfiles.authoritative_verification[field] !== profile[field])) {
    throw new Error("compatibility verification profile differs from authoritative_verification");
  }
  if (decisions["DEC-004"].pathPattern !== "0.6.6-candidate-<implementationCommit12>") {
    throw new Error("DEC-004 candidate identity pattern is invalid");
  }
}

async function assertExternalEvidence(evidence, status, integrity) {
  if (Number(evidence.schemaVersion) < 3 || evidence.result !== "PASS") {
    throw new Error("GitHub external evidence must be a schema-v3 PASS attestation");
  }
  const target = object(status.releaseTarget, "release target binding");
  const repository = String(target.repository ?? "");
  const branch = String(target.branch ?? "");
  const qualificationCommit = gitObjectId(target.qualificationCommit, "release target qualification commit");
  const qualificationTree = gitObjectId(target.qualificationTree, "release target qualification tree");
  const workflow = object(target.workflow, "release workflow binding");
  if (repository !== "zyc14588/codex-harness-skill" || !branch.startsWith("repair/0.6.6-")) {
    throw new Error("release target repository/branch binding is invalid");
  }
  if (workflow.path !== ".github/workflows/ci.yml") throw new Error("release workflow path binding is invalid");
  if (status.releaseStatus === "seal_ready") {
    nonCyclicSealReadyBinding(status, integrity);
  }
  let workflowSha256 = sha256(workflow.sha256, "release workflow SHA-256");
  if (integrity.git.available) {
    const workflowPath = path.join(integrity.git.top, workflow.path);
    const checkedOutWorkflowSha256 = await sha256File(workflowPath);
    if (checkedOutWorkflowSha256 !== workflowSha256) throw new Error("checked-out workflow SHA-256 mismatch");
    workflowSha256 = checkedOutWorkflowSha256;
  }
  if (evidence.repository !== repository || evidence.targetBranch !== branch
    || evidence.targetCommit !== qualificationCommit || evidence.targetTree !== qualificationTree) {
    throw new Error("GitHub external evidence repository/branch/exact qualification head/tree mismatch");
  }
  const evidenceWorkflow = object(evidence.workflow, "GitHub workflow evidence");
  if (evidenceWorkflow.path !== workflow.path || evidenceWorkflow.sha256 !== workflowSha256) {
    throw new Error("GitHub workflow path/SHA-256 mismatch");
  }
  const run = object(evidence.actionsRun, "GitHub Actions run evidence");
  const expectedWorkflowRef = `${repository}/.github/workflows/ci.yml@refs/heads/${branch}`;
  if (!Number.isSafeInteger(run.runId) || run.runId <= 0
    || !Number.isSafeInteger(run.runAttempt) || run.runAttempt <= 0
    || run.headSha !== qualificationCommit || run.workflowRef !== expectedWorkflowRef
    || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("GitHub Actions run does not bind a successful exact qualification head");
  }
  const strict = object(run.strictLocalGates, "strict-local-gates job evidence");
  if (!Number.isSafeInteger(strict.jobId) || strict.jobId <= 0 || strict.conclusion !== "success") {
    throw new Error("strict-local-gates job did not conclude success");
  }
  const protectedSmoke = object(run.protectedRealProviderSmoke, "protected Provider smoke evidence");
  if (!Number.isSafeInteger(protectedSmoke.jobId) || protectedSmoke.jobId <= 0
    || protectedSmoke.conclusion !== "success" || protectedSmoke.environment !== "deepseek-provider-smoke") {
    throw new Error("protected Provider smoke was skipped or did not conclude success in the protected environment");
  }
  const artifact = object(protectedSmoke.artifact, "protected Provider evidence artifact");
  const expectedArtifactName = `codex-harness-provider-evidence-${qualificationCommit}.tar`;
  const expectedArtifactUrl = `https://github.com/${repository}/actions/runs/${String(run.runId)}/artifacts/${String(artifact.id)}`;
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.name !== expectedArtifactName
    || artifact.url !== expectedArtifactUrl) {
    throw new Error("protected Provider evidence artifact identity is invalid");
  }
  const artifactSha256 = sha256(artifact.sha256, "protected Provider evidence artifact SHA-256");
  const attestation = object(artifact.attestation, "protected Provider artifact attestation");
  const expectedAttestationUrl = `https://github.com/${repository}/attestations/${String(attestation.id)}`;
  if (attestation.type !== "github-artifact-attestation" || attestation.verified !== true
    || !Number.isSafeInteger(attestation.id) || attestation.id <= 0
    || attestation.url !== expectedAttestationUrl || attestation.repository !== repository
    || attestation.workflowRef !== expectedWorkflowRef || attestation.subjectSha256 !== artifactSha256) {
    throw new Error("protected Provider evidence artifact lacks a verified digest attestation");
  }
  const protection = object(evidence.branchProtection, "branch protection/ruleset evidence");
  if (protection.status !== "PASS" || protection.httpStatus !== 200
    || protection.requiredChecksConfigured !== true
    || protection.strictLocalGatesRequired !== true
    || protection.protectedProviderSmokeRequired !== true) {
    throw new Error("branch protection/ruleset required checks are not proven active");
  }
}

async function cryptographicallyVerifyExternalSubject(evidence, status, subjectPath) {
  if (!subjectPath) throw new Error("seal-ready source requires the downloaded attested Provider evidence subject");
  const suppliedInfo = await lstat(subjectPath);
  if (!suppliedInfo.isFile() || suppliedInfo.isSymbolicLink()) {
    throw new Error("external attestation subject must be a regular non-symlink file");
  }
  const canonical = await realpath(subjectPath);
  const info = await lstat(canonical);
  if (!info.isFile()) throw new Error("external attestation subject must resolve to a regular file");
  const repository = String(object(status.releaseTarget, "release target binding").repository ?? "");
  const artifact = object(object(object(evidence.actionsRun, "GitHub Actions run evidence").protectedRealProviderSmoke, "protected Provider smoke evidence").artifact, "protected Provider evidence artifact");
  const expectedSha256 = sha256(artifact.sha256, "protected Provider evidence artifact SHA-256");
  if (await sha256File(canonical) !== expectedSha256) throw new Error("downloaded external subject SHA-256 differs from GitHub artifact evidence");
  const verified = spawnSync("gh", ["attestation", "verify", canonical, "--repo", repository, "--format", "json"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10_000_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, NO_COLOR: "1" },
  });
  if (verified.status !== 0) {
    throw new Error(`GitHub/Sigstore cryptographic attestation verification failed: ${String(verified.stderr || verified.stdout).trim()}`);
  }
  let proof;
  try { proof = JSON.parse(verified.stdout); } catch { throw new Error("gh attestation verify did not return JSON proof"); }
  if ((Array.isArray(proof) && proof.length === 0) || (!Array.isArray(proof) && (!proof || typeof proof !== "object"))) {
    throw new Error("gh attestation verify returned an empty proof set");
  }
  return { subjectSha256: expectedSha256, verifierOutputSha256: sha256Text(verified.stdout) };
}

async function assertSourceAndEvidence(root, status, { requireGit, externalEvidence: externalEvidencePath, externalSubject }) {
  assertStableSourceGates(status);
  const implementation = object(status.implementation, "implementation binding");
  gitObjectId(implementation.commit, "implementation commit");
  gitObjectId(implementation.tree, "implementation tree");
  if (!Number.isFinite(Date.parse(String(implementation.committedAt ?? "")))) {
    throw new Error("stable implementation timestamp binding is invalid");
  }
  const integrity = await releaseIntegrity(root);
  if (requireGit && !integrity.git.available) throw new Error("seal-ready source verification requires a Git checkout");
  if (integrity.git.available) {
    if (integrity.git.repositoryClean !== true) {
      throw new Error(`release seal requires a clean repository worktree and index${integrity.git.repositoryStatus ? `: ${integrity.git.repositoryStatus}` : ""}`);
    }
    const sourceBinding = implementationScopeBinding(root, implementation.commit);
    if (sourceBinding.exact !== true) {
      throw new Error(`current source differs from the implementation commit: ${sourceBinding.changedPaths.join(",")}`);
    }
    if (sourceBinding.allowedMetadataOnly !== true) {
      throw new Error(`unauthorized post-implementation metadata changed: ${sourceBinding.unauthorizedMetadataChanges.join(",")}`);
    }
    if (status.releaseStatus === "seal_ready") {
      const target = object(status.releaseTarget, "release target binding");
      const qualificationCommit = gitObjectId(target.qualificationCommit, "release target qualification commit");
      const qualificationBinding = implementationScopeBinding(root, qualificationCommit);
      if (qualificationBinding.exact !== true || qualificationBinding.allowedMetadataOnly !== true) {
        throw new Error("checked-out seal contains changes beyond the exact post-qualification metadata allowlist");
      }
    }
    const sourceTreeAtImplementation = git(root, ["rev-parse", `${implementation.commit}:${integrity.git.relative}`]);
    if (sourceTreeAtImplementation.status !== 0 || sourceTreeAtImplementation.stdout.trim() !== implementation.tree) {
      throw new Error("implementation source Git tree binding is invalid");
    }
  }
  const bindings = object(status.artifactBindings, "artifact bindings");
  if (bindings.sourceTreeSha256 !== integrity.source.sha256) throw new Error("canonical source-tree SHA-256 mismatch");
  if (bindings.packageLockSha256 !== await sha256File(path.join(root, "bridge/package-lock.json"))) throw new Error("package-lock SHA-256 mismatch");
  if (bindings.sourceProvenanceSha256 !== await sha256File(path.join(root, "SOURCE_PROVENANCE.json"))) throw new Error("source provenance SHA-256 mismatch");
  const critical = object(bindings.criticalPathSha256, "critical path bindings");
  if (JSON.stringify(Object.keys(critical)) !== JSON.stringify(CRITICAL_PATHS)
    || JSON.stringify(critical) !== JSON.stringify(integrity.critical.entries)
    || bindings.criticalSetSha256 !== integrity.critical.setSha256) {
    throw new Error("critical-path hash set mismatch");
  }
  const config = await jsonFile(path.join(root, "config/config.example.json"), "config example");
  await assertOwnerDecisions(root, config);
  const harness = object(bindings.harness, "Harness binding");
  if (harness.commit !== config.pinnedHarnessCommit || harness.buildSha256 !== config.pinnedHarnessBuildSha256) {
    throw new Error("Harness commit/build binding differs from runtime config");
  }
  const provenance = await jsonFile(path.join(root, "SOURCE_PROVENANCE.json"), "source provenance");
  if (provenance.repairLine?.implementationCommit !== implementation.commit
    || provenance.repairLine?.implementationTree !== implementation.tree) {
    throw new Error("source provenance does not bind the implementation commit/tree");
  }
  const evidenceBindings = object(bindings.requiredEvidenceSha256, "required evidence bindings");
  const localEvidence = [
    status.localQualificationEvidencePath,
    status.realProviderEvidencePath,
    status.negativeSmokeEvidencePath,
  ];
  const requiredEvidence = [...localEvidence, status.externalGateEvidencePath];
  if (requiredEvidence.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("stable release lacks an explicit required evidence path");
  }
  exactKeys(evidenceBindings, [...(requireGit ? localEvidence : requiredEvidence)].sort(), "required evidence bindings");
  if (bindings.observationalEvidenceSha256?.[status.externalGateEvidencePath] !== undefined) {
    throw new Error("GitHub external evidence cannot be observational");
  }
  const implementationTime = Date.parse(implementation.committedAt);
  let smoke;
  let external;
  for (const relative of (requireGit ? localEvidence : requiredEvidence)) {
    const target = await boundFile(root, relative, String(evidenceBindings[relative]), `release evidence ${relative}`);
    const evidence = await jsonFile(target, `release evidence ${relative}`);
    if (!Number.isFinite(Date.parse(String(evidence.generatedAt ?? ""))) || Date.parse(evidence.generatedAt) <= implementationTime) {
      throw new Error(`release evidence predates or lacks the implementation timestamp: ${relative}`);
    }
    if (relative === status.externalGateEvidencePath) {
      external = evidence;
      continue;
    }
    if (evidence.sourceCommit !== implementation.commit || evidence.sourceTree !== implementation.tree
      || evidence.sourceTreeSha256 !== integrity.source.sha256 || evidence.criticalSetSha256 !== integrity.critical.setSha256) {
      throw new Error(`release evidence is not bound to current source/critical paths: ${relative}`);
    }
    if (relative === status.realProviderEvidencePath) smoke = evidence;
  }
  if (requireGit) {
    if (!externalEvidencePath) throw new Error("seal-ready source requires repository-external GitHub evidence input");
    const canonicalEvidence = await realpath(externalEvidencePath);
    const relativeToRepository = path.relative(integrity.git.top, canonicalEvidence);
    if (relativeToRepository === "" || (!relativeToRepository.startsWith("..") && !path.isAbsolute(relativeToRepository))) {
      throw new Error("seal-ready GitHub evidence must remain outside the clean repository checkout");
    }
    external = await jsonFile(canonicalEvidence, "repository-external GitHub evidence");
    if (!Number.isFinite(Date.parse(String(external.generatedAt ?? ""))) || Date.parse(external.generatedAt) <= implementationTime) {
      throw new Error("repository-external GitHub evidence predates or lacks the implementation timestamp");
    }
    await cryptographicallyVerifyExternalSubject(external, status, externalSubject);
  }
  assertSmokeQualification(smoke, status, integrity);
  await assertExternalEvidence(external, status, integrity);
  return { integrity, requiredEvidenceCount: requiredEvidence.length };
}

async function assertPackageOrigin(root, status, integrity) {
  const originPath = path.join(root, "package-origin.json");
  const origin = await jsonFile(originPath, "package-origin.json");
  if (origin.schemaVersion !== 1 || origin.kind !== EXPECTED_PACKAGE_ORIGIN_KIND
    || origin.version !== STABLE_VERSION || origin.releaseStatus !== "stable") {
    throw new Error("stable installation requires a packaging-stage package-origin marker");
  }
  const target = object(status.releaseTarget, "release target binding");
  if (origin.repository !== target.repository || origin.branch !== target.branch
    || origin.sealCommit !== target.sealCommit || origin.sealTree !== target.sealTree
    || origin.implementationCommit !== status.implementation.commit
    || origin.implementationTree !== status.implementation.tree
    || origin.sourceTreeSha256 !== integrity.source.sha256
    || origin.workflowSha256 !== target.workflow?.sha256
    || origin.archiveName !== EXPECTED_ARCHIVE_NAME) {
    throw new Error("package-origin marker does not bind the exact source/seal/workflow/archive identity");
  }
  return { origin, sha256: await sha256File(originPath) };
}

async function validateArchive(options, status, packageOriginSha256) {
  if (!options.archive && !options.sidecar && !options.validation) {
    if (options.requireArchive) throw new Error("final archive validation requires --archive, --sidecar and --validation");
    return false;
  }
  if (!options.archive || !options.sidecar || !options.validation) throw new Error("archive validation arguments must be supplied together");
  if (path.basename(options.archive) !== EXPECTED_ARCHIVE_NAME || status.finalArchive?.name !== EXPECTED_ARCHIVE_NAME) {
    throw new Error(`stable archive name must be ${EXPECTED_ARCHIVE_NAME}`);
  }
  const archiveSha256 = await sha256File(options.archive);
  const sidecar = (await readFile(options.sidecar, "utf8")).trim();
  if (sidecar !== `${archiveSha256}  ${EXPECTED_ARCHIVE_NAME}`) throw new Error("archive SHA-256 sidecar does not bind the final archive");
  const validation = await jsonFile(options.validation, "archive validation sidecar");
  if (validation.schemaVersion !== 2 || validation.result !== "PASS"
    || validation.archive !== EXPECTED_ARCHIVE_NAME || validation.archiveSha256 !== archiveSha256
    || validation.packageOriginSha256 !== packageOriginSha256) {
    throw new Error("archive validation sidecar is inconsistent");
  }
  exactKeys(validation.checks, REQUIRED_ARCHIVE_CHECKS, "archive validation checks");
  if (REQUIRED_ARCHIVE_CHECKS.some((key) => validation.checks[key] !== "PASS")) {
    throw new Error("every required archive validation check must be exactly PASS");
  }
  const target = object(status.releaseTarget, "release target binding");
  if (validation.sealCommit !== target.sealCommit || validation.sealTree !== target.sealTree
    || validation.implementationCommit !== status.implementation.commit) {
    throw new Error("archive validation does not bind the exact seal and implementation");
  }
  const attestation = object(validation.attestation, "archive validation attestation");
  const expectedChain = sha256Text([
    archiveSha256,
    packageOriginSha256,
    target.sealCommit,
    target.sealTree,
    status.implementation.commit,
  ].join("\n"));
  if (attestation.type !== "sha256-chain-v1" || attestation.verified !== true || attestation.chainSha256 !== expectedChain) {
    throw new Error("archive validation attestation hash chain is invalid");
  }
  return true;
}

export async function verifyReleaseGate(options) {
  const root = path.resolve(options.root);
  const status = await jsonFile(path.join(root, "release-status.json"), "release-status.json");
  if (status.releaseStatus === "withdrawn") throw new Error("withdrawn releases are never installable");
  if (status.releaseStatus === "candidate") {
    if (![CANDIDATE_VERSION, STABLE_VERSION].includes(status.version)) {
      throw new Error(`candidate version must be ${CANDIDATE_VERSION}, or ${STABLE_VERSION} during final-version qualification`);
    }
    if (status.version === STABLE_VERSION && status.qualificationStage !== "FINAL_VERSION_CURRENT_REVISION_QUALIFICATION") {
      throw new Error("a 0.6.6 candidate requires the explicit final-version qualification stage");
    }
    if (!options.auditCandidate) throw new Error("candidate release requires explicit --audit-candidate acknowledgement");
    if (status.controlledUseAllowed !== false || status.deliverableStatus === "DELIVERABLE_PASS") {
      throw new Error("candidate release contains a forbidden stable/controlled-use claim");
    }
    if (status.finalArchive !== undefined && status.finalArchive !== null) throw new Error("candidate release must not declare a final archive");
    await assertVersionSurfaces(root, status.version);
    const integrity = await releaseIntegrity(root);
    return {
      releaseStatus: "candidate",
      installMode: "audit-only",
      skipSelfTests: options.skipSelfTests === true,
      sourceTreeSha256: integrity.source.sha256,
      criticalSetSha256: integrity.critical.setSha256,
    };
  }
  if (status.releaseStatus === "seal_ready") {
    if (!options.sealReady) throw new Error("seal-ready source requires explicit --seal-ready verification");
    if (status.version !== STABLE_VERSION || status.controlledUseAllowed !== false
      || status.deliverableStatus !== "SEAL_READY" || status.realProviderSmoke !== "pass") {
      throw new Error("seal-ready source must remain non-controlled and fully source-qualified");
    }
    if (status.finalArchive !== null) throw new Error("seal-ready source must not declare an archive before packaging");
    if (options.skipSelfTests || options.requireArchive) throw new Error("seal-ready source verification cannot skip tests or claim archive validation");
    await assertVersionSurfaces(root, STABLE_VERSION);
    const source = await assertSourceAndEvidence(root, status, {
      requireGit: true,
      externalEvidence: options.externalEvidence,
      externalSubject: options.externalSubject,
    });
    return {
      releaseStatus: "seal_ready",
      installMode: "not-installable",
      sourceTreeSha256: source.integrity.source.sha256,
      criticalSetSha256: source.integrity.critical.setSha256,
      evidenceBindings: source.requiredEvidenceCount,
      archiveValidated: false,
    };
  }
  if (status.releaseStatus !== "stable") throw new Error(`unsupported releaseStatus: ${String(status.releaseStatus)}`);
  if (status.version !== STABLE_VERSION) throw new Error(`stable version must be ${STABLE_VERSION}`);
  if (options.auditCandidate || options.sealReady) throw new Error("stable release must not use a source-checkout acknowledgement");
  if (options.skipSelfTests) throw new Error("stable release installation cannot skip deterministic self-tests");
  if (status.controlledUseAllowed !== true || status.deliverableStatus !== "DELIVERABLE_PASS" || status.realProviderSmoke !== "pass") {
    throw new Error("stable release requires controlled use, deliverable PASS, and current real Provider PASS");
  }
  await assertVersionSurfaces(root, STABLE_VERSION);
  const source = await assertSourceAndEvidence(root, status, { requireGit: false });
  const packageOrigin = await assertPackageOrigin(root, status, source.integrity);
  if (options.auditPackageStaging) {
    if (options.requireArchive || options.archive || options.sidecar || options.validation) {
      throw new Error("package-staging audit cannot claim external archive validation");
    }
    return {
      releaseStatus: "stable",
      installMode: "packaging-audit-only",
      sourceTreeSha256: source.integrity.source.sha256,
      criticalSetSha256: source.integrity.critical.setSha256,
      evidenceBindings: source.requiredEvidenceCount,
      archiveValidated: false,
    };
  }
  if (!options.requireArchive) throw new Error("stable release always requires exact external archive validation");
  const archiveValidated = await validateArchive(options, status, packageOrigin.sha256);
  return {
    releaseStatus: "stable",
    installMode: "controlled",
    sourceTreeSha256: source.integrity.source.sha256,
    criticalSetSha256: source.integrity.critical.setSha256,
    evidenceBindings: source.requiredEvidenceCount,
    archiveValidated,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await verifyReleaseGate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Release gate rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
