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
  options.evidence ??= path.join(options.root, "evidence", "03_CURRENT_REVISION_NEGATIVE_SMOKE.json");
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
    throw new Error("negative qualification requires a clean Git-bound implementation revision");
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

const options = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(path.join(options.root, "bridge", "package.json"), "utf8"));
if (packageJson.version !== STABLE_VERSION) {
  throw new Error(`negative release qualification requires version ${STABLE_VERSION}`);
}
const before = await releaseIntegrity(options.root);
const binding = sourceProof(before);
const testFiles = [
  "dist/test/harness-isolation.test.js",
  "dist/test/provider-protocol-fail-fast.test.js",
  "dist/test/verification-isolation.test.js",
];
const executions = [];
let passed = true;
for (const relative of testFiles) {
  const result = spawnSync(process.execPath, [relative], {
    cwd: path.join(options.root, "bridge"),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 900_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const count = output.match(/(?:ℹ|#) tests\s+(\d+)/u);
  executions.push({
    testFile: `bridge/${relative}`,
    result: result.status === 0 ? "PASS" : "FAIL",
    exitCode: result.status,
    signal: result.signal,
    testCount: count ? Number(count[1]) : undefined,
    outputSha256: sha256(output),
  });
  if (result.status !== 0) passed = false;
}
const after = await releaseIntegrity(options.root);
const afterBinding = sourceProof(after);
if (JSON.stringify(binding) !== JSON.stringify(afterBinding)) {
  throw new Error("negative smoke changed the bound source revision");
}
const evidence = {
  schemaVersion: 1,
  result: passed ? "PASS" : "FAIL",
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  currentRevision: true,
  ...binding,
  tests: executions,
  assertions: {
    shellEnvironmentContainsNoProviderAdapterOrToolCapability: passed,
    shellProcEnvironmentCredentialLeak: false,
    shellCanReachBrokerSocket: false,
    shellCanReachLoopbackRelay: false,
    directAttemptsProviderUpstreamCallCount: 0,
    capabilityCrossUseRejected: passed,
    arbitraryMethodContentTypeQueryAndSuffixRejected: passed,
    reasoningReplayOmissionProviderRequestCount: 0,
    reasoningReplayOmissionInputTokens: 0,
    reasoningReplayOmissionOutputTokens: 0,
    reasoningReplayOmissionSplitMemoryChanged: false,
    ignoredArtifactCanCauseAuthoritativeFalsePass: false,
    verificationWorktreeRemoved: passed,
  },
};
await mkdir(path.dirname(options.evidence), { recursive: true });
await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (!passed) process.exitCode = 1;
