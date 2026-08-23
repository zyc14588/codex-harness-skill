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
  releaseIntegrity,
  sha256File,
} from "./release-integrity.mjs";

function usage() {
  process.stderr.write("Usage: verify-release-gate.mjs --root PATH [--audit-candidate] [--skip-self-tests] [--require-archive --archive ZIP --sidecar FILE --validation FILE]\n");
}

function parseArgs(argv) {
  const result = { auditCandidate: false, skipSelfTests: false, requireArchive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--archive", "--sidecar", "--validation"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = path.resolve(value);
    } else if (arg === "--audit-candidate") result.auditCandidate = true;
    else if (arg === "--skip-self-tests") result.skipSelfTests = true;
    else if (arg === "--require-archive") result.requireArchive = true;
    else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.root) throw new Error("--root is required");
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function validateArchive(options, status) {
  if (!options.archive && !options.sidecar && !options.validation) {
    if (options.requireArchive) throw new Error("final archive validation requires --archive, --sidecar and --validation");
    return false;
  }
  if (!options.archive || !options.sidecar || !options.validation) throw new Error("archive validation arguments must be supplied together");
  const expectedName = "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip";
  if (path.basename(options.archive) !== expectedName || status.finalArchive?.name !== expectedName) {
    throw new Error(`stable archive name must be ${expectedName}`);
  }
  const archiveSha256 = await sha256File(options.archive);
  const sidecar = (await readFile(options.sidecar, "utf8")).trim();
  if (sidecar !== `${archiveSha256}  ${expectedName}`) throw new Error("archive SHA-256 sidecar does not bind the final archive");
  const validation = await jsonFile(options.validation, "archive validation sidecar");
  if (validation.result !== "PASS" || validation.archive !== expectedName || validation.archiveSha256 !== archiveSha256) {
    throw new Error("archive validation sidecar is inconsistent");
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
  if (status.releaseStatus !== "stable") throw new Error(`unsupported releaseStatus: ${String(status.releaseStatus)}`);
  if (status.version !== STABLE_VERSION) throw new Error(`stable version must be ${STABLE_VERSION}`);
  if (options.auditCandidate) throw new Error("stable release must not use candidate acknowledgement");
  if (options.skipSelfTests) throw new Error("stable release installation cannot skip deterministic self-tests");
  if (status.controlledUseAllowed !== true || status.deliverableStatus !== "DELIVERABLE_PASS" || status.realProviderSmoke !== "pass") {
    throw new Error("stable release requires controlled use, deliverable PASS, and current real Provider PASS");
  }
  await assertVersionSurfaces(root, STABLE_VERSION);
  const gates = object(status.gates, "release gates");
  if (Object.keys(gates).length === 0 || Object.values(gates).some((value) => value !== "PASS")) {
    throw new Error("every stable release gate must be exactly PASS");
  }
  const implementation = object(status.implementation, "implementation binding");
  if (!/^[0-9a-f]{40,64}$/u.test(String(implementation.commit ?? ""))
    || !/^[0-9a-f]{40,64}$/u.test(String(implementation.tree ?? ""))
    || !Number.isFinite(Date.parse(String(implementation.committedAt ?? "")))) {
    throw new Error("stable implementation commit/tree/timestamp binding is invalid");
  }
  const integrity = await releaseIntegrity(root);
  if (integrity.git.available && integrity.git.sourceClean !== true) {
    throw new Error("stable canonical source scope differs from the checked-out release seal");
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
  const harness = object(bindings.harness, "Harness binding");
  if (harness.commit !== config.pinnedHarnessCommit || harness.buildSha256 !== config.pinnedHarnessBuildSha256) {
    throw new Error("Harness commit/build binding differs from runtime config");
  }
  const provenance = await jsonFile(path.join(root, "SOURCE_PROVENANCE.json"), "source provenance");
  if (provenance.repairLine?.implementationCommit !== implementation.commit
    || provenance.repairLine?.implementationTree !== implementation.tree) {
    throw new Error("source provenance does not bind the stable implementation commit/tree");
  }
  if (integrity.git.available) {
    const ancestor = git(root, ["merge-base", "--is-ancestor", implementation.commit, "HEAD"]);
    if (ancestor.status !== 0) throw new Error("implementation commit is not an ancestor of the checked-out release seal");
    const sourceTreeAtImplementation = git(root, ["rev-parse", `${implementation.commit}:${integrity.git.relative}`]);
    if (sourceTreeAtImplementation.status !== 0 || sourceTreeAtImplementation.stdout.trim() !== implementation.tree) {
      throw new Error("implementation source Git tree binding is invalid");
    }
  }
  const evidenceBindings = object(bindings.requiredEvidenceSha256, "required evidence bindings");
  const requiredEvidence = Object.keys(evidenceBindings);
  if (requiredEvidence.length < 3 || !requiredEvidence.includes(status.realProviderEvidencePath)
    || !requiredEvidence.includes(status.negativeSmokeEvidencePath)) {
    throw new Error("stable release lacks current local, real Provider, and negative evidence bindings");
  }
  const implementationTime = Date.parse(implementation.committedAt);
  let smoke;
  for (const relative of requiredEvidence) {
    const target = await boundFile(root, relative, String(evidenceBindings[relative]), `release evidence ${relative}`);
    const evidence = await jsonFile(target, `release evidence ${relative}`);
    if (!Number.isFinite(Date.parse(String(evidence.generatedAt ?? ""))) || Date.parse(evidence.generatedAt) <= implementationTime) {
      throw new Error(`release evidence predates or lacks the implementation timestamp: ${relative}`);
    }
    if (evidence.sourceCommit !== implementation.commit || evidence.sourceTree !== implementation.tree
      || evidence.sourceTreeSha256 !== integrity.source.sha256 || evidence.criticalSetSha256 !== integrity.critical.setSha256) {
      throw new Error(`release evidence is not bound to current source/critical paths: ${relative}`);
    }
    if (relative === status.realProviderEvidencePath) smoke = evidence;
  }
  assertSmokeQualification(smoke, status, integrity);
  const archiveValidated = await validateArchive(options, status);
  return {
    releaseStatus: "stable",
    installMode: "controlled",
    sourceTreeSha256: integrity.source.sha256,
    criticalSetSha256: integrity.critical.setSha256,
    evidenceBindings: requiredEvidence.length,
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
