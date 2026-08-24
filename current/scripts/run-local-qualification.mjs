#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STABLE_VERSION, releaseIntegrity } from "./release-integrity.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--root", "--evidence"].includes(name)) throw new Error(`unknown argument: ${name}`);
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    options[name.slice(2)] = path.resolve(value);
  }
  options.root ??= path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  options.evidence ??= path.join(options.root, "evidence", "01_CURRENT_REVISION_LOCAL_QUALIFICATION.json");
  const relative = path.relative(options.root, options.evidence);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("--evidence must remain inside --root");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceProof(integrity) {
  if (integrity.git.available !== true || integrity.git.sourceClean !== true
    || !/^[0-9a-f]{40,64}$/u.test(String(integrity.git.commit ?? ""))
    || !/^[0-9a-f]{40,64}$/u.test(String(integrity.git.sourceTree ?? ""))) {
    throw new Error("local qualification requires a clean Git-bound implementation revision");
  }
  return {
    sourceCommit: integrity.git.commit,
    sourceTree: integrity.git.sourceTree,
    sourceTreeSha256: integrity.source.sha256,
    sourceFileCount: integrity.source.files.length,
    criticalSetSha256: integrity.critical.setSha256,
    criticalPathSha256: integrity.critical.entries,
  };
}

function testCount(output) {
  const matches = [...output.matchAll(/(?:ℹ|#) tests\s+(\d+)/gu)];
  return matches.reduce((sum, match) => sum + Number(match[1]), 0);
}

const options = parseArgs(process.argv.slice(2));
const bridge = path.join(options.root, "bridge");
const packageJson = JSON.parse(await readFile(path.join(bridge, "package.json"), "utf8"));
if (packageJson.version !== STABLE_VERSION) {
  throw new Error(`local release qualification requires version ${STABLE_VERSION}`);
}
const before = await releaseIntegrity(options.root);
const binding = sourceProof(before);
const steps = [
  { name: "candidate-release-gate", command: process.execPath, args: ["scripts/verify-release-gate.mjs", "--root", ".", "--audit-candidate"], cwd: options.root, timeout: 60_000 },
  { name: "reproducible-dependency-install", command: "npm", args: ["ci"], cwd: bridge, timeout: 600_000 },
  { name: "strict-typescript-build", command: "npm", args: ["run", "build"], cwd: bridge, timeout: 180_000 },
  { name: "release-gate-negative-tests", command: process.execPath, args: ["scripts/release-gate.test.mjs"], cwd: options.root, timeout: 120_000 },
  { name: "unit-and-component-regression", command: "npm", args: ["test"], cwd: bridge, timeout: 900_000 },
  { name: "process-e2e", command: process.execPath, args: ["dist/direct-acceptance.js"], cwd: bridge, timeout: 900_000 },
  { name: "managed-profile-dynamic-fixture", command: process.execPath, args: ["dist/dynamic-profile-fixture.js"], cwd: bridge, timeout: 300_000 },
  { name: "stdio-mcp", command: process.execPath, args: ["dist/acceptance-client.js"], cwd: bridge, timeout: 300_000 },
  { name: "security-acceptance", command: path.join(options.root, "scripts", "security-acceptance.sh"), args: [], cwd: options.root, timeout: 300_000 },
  { name: "skill-validation", command: process.execPath, args: ["scripts/validate-skill.mjs", "skills/codex-harness"], cwd: options.root, timeout: 120_000 },
  { name: "generated-dist-drift", command: "git", args: ["diff", "--exit-code", "--", "current/bridge/dist"], cwd: path.dirname(options.root), timeout: 120_000 },
  { name: "manifest-regeneration", command: process.execPath, args: ["scripts/update-manifest.mjs", "."], cwd: options.root, timeout: 120_000 },
  { name: "manifest-verification", command: "sha256sum", args: ["-c", "MANIFEST_SHA256.txt"], cwd: options.root, timeout: 300_000 },
  { name: "transactional-package-acceptance", command: path.join(options.root, "scripts", "package-acceptance.sh"), args: [], cwd: options.root, timeout: 1_200_000,
    env: { CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E: "1" } },
];
const executions = [];
let passed = true;
for (const step of steps) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...(step.env ?? {}) },
    timeout: step.timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  executions.push({
    name: step.name,
    result: result.status === 0 ? "PASS" : "FAIL",
    exitCode: result.status,
    signal: result.signal,
    startedAt,
    durationMs: Date.now() - started,
    testCount: testCount(output),
    outputSha256: sha256(output),
  });
  if (result.status !== 0) {
    passed = false;
    process.stderr.write(`qualification step failed: ${step.name}\n${output.slice(-20_000)}\n`);
    break;
  }
}
const after = await releaseIntegrity(options.root);
const afterBinding = sourceProof(after);
if (JSON.stringify(binding) !== JSON.stringify(afterBinding)) {
  throw new Error("local qualification changed the bound canonical source revision");
}
const evidence = {
  schemaVersion: 1,
  result: passed && executions.length === steps.length ? "PASS" : "FAIL",
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  currentRevision: true,
  ...binding,
  testCount: executions.reduce((sum, entry) => sum + entry.testCount, 0),
  steps: executions,
  assertions: {
    strictTypeScriptBuild: executions.some((entry) => entry.name === "strict-typescript-build" && entry.result === "PASS"),
    allUnitAndComponentTests: executions.some((entry) => entry.name === "unit-and-component-regression" && entry.result === "PASS"),
    realManagedProfileDynamicFixture: executions.some((entry) => entry.name === "managed-profile-dynamic-fixture" && entry.result === "PASS"),
    processE2E: executions.some((entry) => entry.name === "process-e2e" && entry.result === "PASS"),
    stdioMcp: executions.some((entry) => entry.name === "stdio-mcp" && entry.result === "PASS"),
    securityAcceptance: executions.some((entry) => entry.name === "security-acceptance" && entry.result === "PASS"),
    brokeredToolCancellationNegatives: executions.some((entry) => entry.name === "unit-and-component-regression" && entry.result === "PASS"),
    resourceExhaustionNegatives: executions.some((entry) => entry.name === "unit-and-component-regression" && entry.result === "PASS"),
    modelReadOutputBounds: executions.some((entry) => entry.name === "unit-and-component-regression" && entry.result === "PASS"),
    operatorAuditAggregationRotationRetention: executions.some((entry) => entry.name === "unit-and-component-regression" && entry.result === "PASS"),
    controlledHostResourceEnforcement: "REQUIRES_PROTECTED_HOST_WITH_ALL_CGROUP_CONTROLLERS",
    skillValidation: executions.some((entry) => entry.name === "skill-validation" && entry.result === "PASS"),
    generatedDistDriftFree: executions.some((entry) => entry.name === "generated-dist-drift" && entry.result === "PASS"),
    transactionalInstallRollbackReinstallUninstall: executions.some((entry) => entry.name === "transactional-package-acceptance" && entry.result === "PASS"),
  },
};
await mkdir(path.dirname(options.evidence), { recursive: true });
await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.result !== "PASS") process.exitCode = 1;
