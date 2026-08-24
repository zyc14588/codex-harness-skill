#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { releaseIntegrity } from "./release-integrity.mjs";
import { verifyReleaseGate } from "./verify-release-gate.mjs";

const ARCHIVE_NAME = "CODEX_HARNESS_BRIDGE_0_6_6_STABLE.zip";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--source", "--staging", "--external-evidence"].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    result[arg === "--external-evidence" ? "externalEvidence" : arg.slice(2)] = path.resolve(value);
  }
  if (!result.source || !result.staging || !result.externalEvidence) {
    throw new Error("Usage: prepare-stable-package.mjs --source PATH --staging PATH --external-evidence FILE");
  }
  return result;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await realpath(options.source);
  const stagingParent = await realpath(path.dirname(options.staging));
  const staging = path.join(stagingParent, path.basename(options.staging));
  if (inside(source, staging) || inside(staging, source)) throw new Error("staging and source roots must not contain one another");
  const externalEvidence = await realpath(options.externalEvidence);
  const externalInfo = await lstat(externalEvidence);
  if (!externalInfo.isFile() || externalInfo.isSymbolicLink()) throw new Error("external evidence must be a regular non-symlink file");

  const qualification = await verifyReleaseGate({
    root: source,
    auditCandidate: false,
    sealReady: true,
    auditPackageStaging: false,
    skipSelfTests: false,
    requireArchive: false,
    externalEvidence,
  });
  if (qualification.releaseStatus !== "seal_ready") throw new Error("source did not reach seal_ready");

  const sourceIntegrity = await releaseIntegrity(source);
  if (!sourceIntegrity.git.available || sourceIntegrity.git.repositoryClean !== true) {
    throw new Error("stable package staging requires a clean Git source seal");
  }
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== ".git" && name !== "node_modules" && name !== "package-origin.json";
    },
  });

  const statusPath = path.join(staging, "release-status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const target = status.releaseTarget;
  target.sealCommit = sourceIntegrity.git.commit;
  target.sealTree = sourceIntegrity.git.repositoryTree;
  const externalRelative = status.externalGateEvidencePath;
  if (typeof externalRelative !== "string" || path.isAbsolute(externalRelative)
    || externalRelative.split(/[\\/]/u).includes("..")) {
    throw new Error("external evidence destination is unsafe");
  }
  const externalData = await readFile(externalEvidence);
  const externalTarget = path.join(staging, externalRelative);
  await mkdir(path.dirname(externalTarget), { recursive: true });
  await writeFile(externalTarget, externalData, { mode: 0o644 });
  status.artifactBindings.requiredEvidenceSha256[externalRelative] = digest(externalData);
  if (status.artifactBindings.observationalEvidenceSha256) {
    delete status.artifactBindings.observationalEvidenceSha256[externalRelative];
  }
  status.releaseStatus = "stable";
  status.qualificationStage = "STABLE_PACKAGE_STAGING";
  status.controlledUseAllowed = true;
  status.deliverableStatus = "DELIVERABLE_PASS";
  status.statusReason = "Stable only when the extracted package is accompanied by the exact archive, SHA sidecar, and validation attestation.";
  status.finalArchive = { name: ARCHIVE_NAME };

  const origin = {
    schemaVersion: 1,
    kind: "codex-harness-stable-package-origin",
    version: status.version,
    releaseStatus: "stable",
    repository: target.repository,
    branch: target.branch,
    sealCommit: target.sealCommit,
    sealTree: target.sealTree,
    implementationCommit: status.implementation.commit,
    implementationTree: status.implementation.tree,
    sourceTreeSha256: qualification.sourceTreeSha256,
    workflowSha256: target.workflow.sha256,
    archiveName: ARCHIVE_NAME,
  };
  await writeFile(path.join(staging, "package-origin.json"), `${JSON.stringify(origin, null, 2)}\n`, { mode: 0o644 });
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({
    result: "PACKAGE_STAGING_READY",
    sourceSealCommit: target.sealCommit,
    sourceSealTree: target.sealTree,
    staging,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Stable package staging rejected: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
