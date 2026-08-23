#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage() {
  process.stderr.write("Usage: verify-release-gate.mjs --root PATH [--audit-candidate] [--skip-self-tests]\n");
}

function parseArgs(argv) {
  let root;
  let auditCandidate = false;
  let skipSelfTests = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      root = argv[++index];
      if (!root) throw new Error("--root requires a value");
    } else if (arg === "--audit-candidate") auditCandidate = true;
    else if (arg === "--skip-self-tests") skipSelfTests = true;
    else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!root) throw new Error("--root is required");
  return { root: path.resolve(root), auditCandidate, skipSelfTests };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function sha256File(file, label) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  return createHash("sha256").update(await readFile(file)).digest("hex");
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
  const actual = await sha256File(target, label);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: ${relative}`);
}

export async function verifyReleaseGate(options) {
  const statusPath = path.join(options.root, "release-status.json");
  const status = object(JSON.parse(await readFile(statusPath, "utf8")), "release-status.json");
  if (status.version !== "0.6.5") throw new Error(`release version must be 0.6.5, got ${String(status.version)}`);
  if (status.releaseStatus === "withdrawn") throw new Error("withdrawn releases are never installable");
  if (status.releaseStatus === "candidate") {
    if (!options.auditCandidate) throw new Error("candidate release requires explicit --audit-candidate acknowledgement");
    if (status.controlledUseAllowed !== false) throw new Error("candidate release must not claim controlledUseAllowed");
    if (status.deliverableStatus === "DELIVERABLE_PASS") {
      throw new Error("candidate release must not claim DELIVERABLE_PASS");
    }
    return { releaseStatus: "candidate", installMode: "audit-only", skipSelfTests: options.skipSelfTests };
  }
  if (status.releaseStatus !== "stable") throw new Error(`unsupported releaseStatus: ${String(status.releaseStatus)}`);
  if (options.skipSelfTests) throw new Error("stable release installation cannot skip deterministic self-tests");
  if (status.controlledUseAllowed !== true || status.deliverableStatus !== "DELIVERABLE_PASS") {
    throw new Error("stable release requires controlledUseAllowed=true and deliverableStatus=DELIVERABLE_PASS");
  }
  const gates = object(status.gates, "release gates");
  if (Object.keys(gates).length === 0 || Object.entries(gates).some(([, value]) => value !== "PASS")) {
    throw new Error("every stable release gate must be exactly PASS");
  }
  const bindings = object(status.artifactBindings, "stable artifactBindings");
  await boundFile(options.root, "SOURCE_PROVENANCE.json", String(bindings.sourceProvenanceSha256 ?? ""), "source provenance");
  await boundFile(options.root, "bridge/package-lock.json", String(bindings.packageLockSha256 ?? ""), "package lock");
  const evidence = object(bindings.requiredEvidenceSha256, "required evidence bindings");
  const required = [
    "evidence/01_DYNAMIC_PROFILE_FIXTURE_REDACTED.json",
    "evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json",
    "evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json",
    "evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json",
    "evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json",
    "evidence/07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json"
  ];
  for (const relative of required) {
    if (!(relative in evidence)) throw new Error(`stable evidence binding is missing: ${relative}`);
    await boundFile(options.root, relative, String(evidence[relative]), `stable evidence ${relative}`);
  }
  return { releaseStatus: "stable", installMode: "controlled", skipSelfTests: false, evidenceBindings: required.length };
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
