import assert from "node:assert/strict";
import http from "node:http";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  cleanupTask,
  collectTask,
  commitTask,
  createControllerPlan,
  finalizeControllerPlan,
  monitorStop,
  readChangedFile,
  reviewTask,
  startTask,
  taskStatus,
  verifyTask,
} from "./service.js";
import { loadTask } from "./store.js";
import type { TaskRecord } from "./types.js";
import { runProcess, sha256PathTree, sleep } from "./util.js";
import { sha256Executable } from "./process-identity.js";
import { createPinnedHostResourceProfile, freezeHostResourceProfile, probeHostResourceProfile, RESOURCE_PROFILE_IDS } from "./resource-controls.js";
import { usageForBudgetGroup } from "./telemetry.js";

type Payload = Record<string, unknown>;

function payload(value: unknown): Payload {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Payload;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxCaptureChars: 200_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function reserveLoopbackPort(): Promise<number> {
  const server = http.createServer((_request, response) => response.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readCredentialApiKey(source: string): Promise<string> {
  const info = await lstat(source);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "real Provider credential source must be a regular non-symlink file");
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), "real Provider credential source must be operator-owned");
  assert.equal(info.mode & 0o077, 0, "real Provider credential source must not be accessible by group or other users");
  const document = await readFile(source, "utf8");
  const line = document.split(/\r?\n/u).find((candidate) => /^\s*DEEPSEEK_API_KEY\s*:/u.test(candidate));
  assert.ok(line, "real Provider credential source does not contain DEEPSEEK_API_KEY");
  let value = line.replace(/^\s*DEEPSEEK_API_KEY\s*:\s*/u, "").trim();
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/gu, "'");
  assert.ok(Buffer.byteLength(value, "utf8") >= 24 && !/[\0\r\n]/u.test(value), "real Provider API key is malformed");
  return value;
}

async function waitTerminal(taskId: string, timeoutMs = 600_000): Promise<Payload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = payload(await taskStatus(taskId));
    if (!new Set(["queued", "running"]).has(String(current.status))) return current;
    await sleep(250);
  }
  throw new Error(`real Provider task did not terminate within ${timeoutMs}ms: ${taskId}`);
}

async function waitProcessesStopped(taskId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = payload(await taskStatus(taskId));
    if (current.workerAlive !== true && current.harnessAlive !== true) return;
    await sleep(100);
  }
  throw new Error(`real Provider task processes did not stop: ${taskId}`);
}

function safeTaskEvidence(task: TaskRecord): Payload {
  return {
    id: task.id,
    model: task.model,
    status: task.status,
    exitCode: task.exitCode,
    changedPaths: task.changedPaths,
    outOfScopePaths: task.outOfScopePaths,
    infrastructureFailureKind: task.infrastructureFailureKind,
    infrastructureFailureDetails: task.infrastructureFailureDetails,
    executionAttempts: task.executionAttempts,
    providerRequestOrdinal: task.providerRequestOrdinal ?? 0,
    thinkingRequestEvidence: task.thinkingRequestEvidence ?? [],
    reasoningReplayRequirements: task.reasoningReplayRequirements ?? [],
    minimalMutationForceCount: task.minimalMutationForceCount ?? 0,
    minimalMutationForcedTools: task.minimalMutationForcedTools ?? [],
    toolProtocolNativeCallCount: task.toolProtocolNativeCallCount ?? 0,
    toolProtocolNativeTools: task.toolProtocolNativeTools ?? [],
    toolProtocolRecoveryCount: task.toolProtocolRecoveryCount ?? 0,
    toolProtocolRecoveredTools: task.toolProtocolRecoveredTools ?? [],
    minimalRequestEvidence: task.minimalRequestEvidence ?? [],
    reviewDecision: task.reviewDecision,
    reviewedPaths: task.reviewedPaths,
    reviewedFingerprint: task.reviewedFingerprint,
    verificationPassed: task.verificationPassed,
    verifiedFingerprint: task.verifiedFingerprint,
    reviewedPatchSha256: task.reviewedPatchSha256,
    verificationCleanStart: task.verificationCleanStart,
    verificationIgnoredResidueExcluded: task.verificationIgnoredResidueExcluded,
    verificationResultFingerprint: task.verificationResultFingerprint,
    verificationWorktreeRemoved: task.verificationWorktreeRemoved,
    bridgeCommit: task.bridgeCommit,
    worktreeRemoved: task.worktreeRemoved ?? false,
    branchDeleted: task.branchDeleted ?? false,
  };
}

interface LeafSpec {
  planId: string;
  leafId: string;
  taskId: string;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  targetPath: string;
  expectedThinking: "disabled" | "enabled";
  minimumRequests: number;
  minimumToolCalls: number;
  minimumNativeToolCalls: number;
}

async function runLeaf(repo: string, expectedContent: string, spec: LeafSpec): Promise<Payload> {
  const objective = [
    `Create exactly ${spec.targetPath} as a byte-for-byte copy of README.md and change no other path.`,
    "The README content is intentionally not included in this prompt, so obtain it with a real tool.",
    "Mandatory sequence within this one attempt:",
    "1. Use exactly one bash tool call to read README.md; do not write in that call.",
    `2. After that tool result, use a separate bash tool call to create ${spec.targetPath}; do not verify in that call.`,
    `3. After that tool result, use a separate bash tool call to run cmp -s README.md ${spec.targetPath} and git diff --check; do not combine this with step 2.`,
    "4. Only after the third tool result, return a concise final response.",
    "Do not combine steps, do not skip the verification tool call, and do not create commits.",
  ].join("\n");
  await createControllerPlan({
    repoRoot: repo,
    planId: spec.planId,
    leaves: [{
      id: spec.leafId,
      objective,
      executor: "harness",
      model: spec.model,
      complexity: spec.model === "deepseek-v4-pro" ? "large" : "small",
      harnessMode: "minimal",
      taskFamily: `real-provider-${spec.model}-multiturn-v1`,
      harnessWritePaths: [spec.targetPath],
      contextFiles: [],
      acceptanceCriteria: [
        `Only ${spec.targetPath} changes`,
        `${spec.targetPath} is byte-for-byte identical to README.md`,
        `At least ${spec.minimumRequests} real Provider requests occur in one immutable attempt`,
        `At least ${spec.minimumToolCalls} real tool calls occur`,
      ],
      verificationCommands: [
        `test -f ${spec.targetPath}`,
        `cmp -s README.md ${spec.targetPath}`,
        "git diff --check",
      ],
      budget: { maxApiCalls: 8, maxInputTokens: 100_000, maxOutputTokens: 10_000, maxCostCny: 5 },
      runtimeSeconds: 600,
    }],
  });
  await startTask({ planId: spec.planId, leafId: spec.leafId, taskId: spec.taskId });
  const terminal = await waitTerminal(spec.taskId);
  const config = await loadConfig();
  let task = await loadTask(config, spec.taskId);
  if (terminal.status !== "completed") {
    throw new Error(`real Provider ${spec.model} task failed: ${JSON.stringify(safeTaskEvidence(task))}`);
  }
  assert.equal(task.infrastructureFailureKind, undefined, JSON.stringify(safeTaskEvidence(task)));
  assert.deepEqual(task.changedPaths, [spec.targetPath]);
  assert.equal(task.executionAttempts?.length, 1);
  const attempt = task.executionAttempts?.[0];
  assert.ok(attempt?.id);
  assert.equal(attempt.model, spec.model);
  assert.equal(attempt.thinkingPolicy?.thinkingType, spec.expectedThinking);
  assert.ok((task.providerRequestOrdinal ?? 0) >= spec.minimumRequests, JSON.stringify(safeTaskEvidence(task)));
  const requestEvidence = task.thinkingRequestEvidence ?? [];
  assert.equal(requestEvidence.length, task.providerRequestOrdinal);
  assert.ok(requestEvidence.every((entry) => entry.attemptId === attempt.id));
  assert.ok(requestEvidence.every((entry) => entry.thinkingType === spec.expectedThinking));
  if (spec.expectedThinking === "disabled") {
    assert.ok(requestEvidence.every((entry) => entry.reasoningEffort === undefined));
    assert.ok((task.minimalRequestEvidence ?? []).every((entry) => entry.providerThinkingType === "disabled"));
  } else {
    assert.ok(requestEvidence.every((entry) => entry.reasoningEffort === "high" && !entry.toolChoicePresent));
    assert.deepEqual(requestEvidence.map((entry) => entry.replayRequirementCount),
      requestEvidence.map((_entry, index) => index), "real Pro request history did not replay 0/1/2... reasoning requirements");
    const requirements = task.reasoningReplayRequirements ?? [];
    assert.ok(requirements.length > 0, "real Pro tool-call response produced no reasoning replay requirement");
    assert.ok(requirements.every((entry) => entry.reasoningUtf8Bytes > 0 && /^[0-9a-f]{64}$/u.test(entry.reasoningSha256)));
    assert.ok(requirements.every((entry) => entry.replayCount > 0), JSON.stringify(requirements));
  }
  const toolCalls = (task.toolProtocolNativeCallCount ?? 0) + (task.toolProtocolRecoveryCount ?? 0);
  assert.ok(toolCalls >= spec.minimumToolCalls, JSON.stringify(safeTaskEvidence(task)));
  assert.ok((task.toolProtocolNativeCallCount ?? 0) >= spec.minimumNativeToolCalls, JSON.stringify(safeTaskEvidence(task)));

  await waitProcessesStopped(spec.taskId);
  const collected = payload(await collectTask(spec.taskId, true, 200_000));
  assert.deepEqual(collected.changedPaths, [spec.targetPath]);
  assert.deepEqual(collected.outOfScopePaths, []);
  assert.deepEqual(collected.unsafeSymlinkPaths, []);
  assert.deepEqual(collected.unsafeGitlinkPaths, []);
  assert.deepEqual(collected.stagedPaths, []);
  const changedFile = payload(await readChangedFile(spec.taskId, spec.targetPath));
  assert.equal(changedFile.content, expectedContent);
  const review = payload(await reviewTask(
    spec.taskId,
    "approved",
    [spec.targetPath],
    `Codex read the complete ${spec.targetPath}, compared it byte-for-byte with README.md, and approved the exact leased change.`,
  ));
  assert.match(String(review.reviewedFingerprint), /^[0-9a-f]{64}$/u);
  const verification = payload(await verifyTask(spec.taskId, undefined, 60));
  assert.equal(verification.passed, true, JSON.stringify(verification));
  assert.equal(verification.reviewedFingerprint, verification.verifiedFingerprint);
  const afterVerification = payload(await collectTask(spec.taskId, false, 0));
  assert.equal(afterVerification.reviewedFingerprint, afterVerification.currentFingerprint);
  assert.equal(afterVerification.currentFingerprint, afterVerification.verifiedFingerprint);
  const committed = payload(await commitTask(spec.taskId, `test(smoke): accept real ${spec.model} multi-turn leaf`));
  assert.match(String(committed.commit), /^[0-9a-f]{40,64}$/u);
  assert.equal(committed.reviewedFingerprint, committed.currentFingerprint);
  assert.equal(committed.currentFingerprint, committed.verifiedFingerprint);
  await finalizeControllerPlan(spec.planId, `Real ${spec.model} multi-turn Provider smoke reviewed, verified, fingerprint-stable, and locally committed.`);
  const usage = await usageForBudgetGroup(config, task.budgetGroupId);
  assert.equal(usage.apiCalls, task.providerRequestOrdinal);
  assert.equal(usage.completedCalls, task.providerRequestOrdinal);
  assert.equal(usage.failedCalls, 0);
  assert.ok(usage.inputTokens + usage.estimatedInputTokens > 0);
  assert.ok(usage.outputTokens + usage.estimatedOutputTokens > 0);
  await cleanupTask(spec.taskId, true, true);
  task = await loadTask(config, spec.taskId);
  assert.equal(task.worktreeRemoved, true);
  assert.equal(task.branchDeleted, true);
  return {
    ...safeTaskEvidence(task),
    requestCount: task.providerRequestOrdinal,
    toolCallCount: toolCalls,
    reviewedFingerprint: afterVerification.reviewedFingerprint,
    currentFingerprint: afterVerification.currentFingerprint,
    verifiedFingerprint: afterVerification.verifiedFingerprint,
    localCommit: committed.commit,
    usage,
  };
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const harnessRoot = path.resolve(process.env.CODEX_REAL_SMOKE_HARNESS_ROOT ?? "/home/zyc14588/deepseek-harness");
const credentialSource = path.resolve(process.env.CODEX_REAL_SMOKE_CREDENTIALS ?? path.join(os.homedir(), ".dsh", ".credentials.yaml"));
const profileModulesSource = path.resolve(process.env.CODEX_REAL_SMOKE_PROFILE_MODULES
  ?? path.join(os.homedir(), ".dsh", "profiles", "node_modules"));
const evidencePath = process.env.CODEX_REAL_SMOKE_EVIDENCE_PATH
  ? path.resolve(process.env.CODEX_REAL_SMOKE_EVIDENCE_PATH)
  : undefined;
const keepRoot = process.env.CODEX_REAL_SMOKE_KEEP_ROOT === "1";
const packageMetadata = payload(JSON.parse(await readFile(path.join(packageRoot, "bridge", "package.json"), "utf8")));
const releaseVersion = String(packageMetadata.version ?? "");
assert.equal(releaseVersion, "0.6.6", "real Provider qualification must run after final-version source promotion");
const integrityRun = await runProcess(process.execPath, [path.join(packageRoot, "scripts", "release-integrity.mjs"), "--root", packageRoot], {
  cwd: packageRoot,
  timeoutMs: 30_000,
  maxCaptureChars: 2_000_000,
});
assert.equal(integrityRun.code, 0, integrityRun.stderr || integrityRun.stdout);
const sourceIntegrity = payload(JSON.parse(integrityRun.stdout));
const sourceBinding = payload(sourceIntegrity.source);
const criticalBinding = payload(sourceIntegrity.critical);
const gitBinding = payload(sourceIntegrity.git);
assert.equal(gitBinding.available, true, "real Provider qualification requires a Git-bound implementation commit");
assert.equal(gitBinding.sourceClean, true, "canonical source scope must be clean before real Provider qualification");
assert.match(String(gitBinding.commit ?? ""), /^[0-9a-f]{40,64}$/u);
assert.match(String(gitBinding.sourceTree ?? ""), /^[0-9a-f]{40,64}$/u);
assert.match(String(sourceBinding.sha256 ?? ""), /^[0-9a-f]{64}$/u);
assert.match(String(criticalBinding.setSha256 ?? ""), /^[0-9a-f]{64}$/u);
const evidenceGeneratedAt = new Date().toISOString();
const temp = await mkdtemp(path.join(os.tmpdir(), "codex-harness-real-provider-"));
const dshHome = path.join(temp, "dsh-home");
const repo = path.join(temp, "smoke-repo");
const stateRoot = path.join(temp, "state");
const providerKeyPath = path.join(stateRoot, "secrets", "provider.key");
const configPath = path.join(temp, "config.json");
const priorConfig = process.env.CODEX_HARNESS_CONFIG;
const priorDshHome = process.env.DSH_HOME;
const priorBaseUrl = process.env.DEEPSEEK_BASE_URL;
const priorProviderKey = process.env.DEEPSEEK_API_KEY;
const priorGithubToken = process.env.GITHUB_TOKEN;
let monitorStarted = false;
let report: Payload = {
  result: "FAIL",
  version: releaseVersion,
  generatedAt: evidenceGeneratedAt,
  currentRevision: true,
  sourceCommit: gitBinding.commit,
  sourceTree: gitBinding.sourceTree,
  sourceTreeSha256: sourceBinding.sha256,
  sourceFileCount: Array.isArray(sourceBinding.files) ? sourceBinding.files.length : undefined,
  criticalSetSha256: criticalBinding.setSha256,
  criticalPathSha256: criticalBinding.entries,
  tempRoot: temp,
};

try {
  const providerKey = await readCredentialApiKey(credentialSource);
  await mkdir(path.dirname(providerKeyPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(providerKeyPath), 0o700);
  await writeFile(providerKeyPath, `${providerKey}\n`, { mode: 0o600 });
  await mkdir(path.join(dshHome, "profiles"), { recursive: true, mode: 0o700 });
  await cp(profileModulesSource, path.join(dshHome, "profiles", "node_modules"), { recursive: true });

  const harnessCommit = await git(harnessRoot, ["rev-parse", "HEAD"]);
  assert.equal(harnessCommit, "141eb6fef83422698aef7a981029e843e8161534");
  assert.equal(await git(harnessRoot, ["status", "--porcelain=v1", "--untracked-files=no"]), "");
  const harnessCli = path.join(harnessRoot, "apps", "cli", "lib", "bin.js");
  const harnessBuildRoot = path.dirname(harnessCli);
  const harnessBuildSha256 = await sha256PathTree(harnessBuildRoot);
  const bwrapIdentity = await sha256Executable("/usr/bin/bwrap");
  const resourceProfile = await createPinnedHostResourceProfile("required");
  const monitorPort = await reserveLoopbackPort();

  await mkdir(repo, { recursive: true });
  const seed = "real-provider-multiturn-seed-2026-08-22\n";
  await writeFile(path.join(repo, "README.md"), seed, { mode: 0o644 });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "real-provider-smoke@example.invalid"]);
  await git(repo, ["config", "user.name", "Real Provider Smoke"]);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-qm", "fixture: real Provider smoke base"]);
  const mainHeadBefore = await git(repo, ["rev-parse", "HEAD"]);

  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 7,
    harnessRoot,
    harnessCli,
    harnessBuildRoot,
    harnessProfile: "headless",
    harnessMinimalProfile: "codex-minimal-headless",
    dshHome,
    stateRoot,
    allowedRepoRoots: [temp],
    passEnvironment: ["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR"],
    defaultRuntimeSeconds: 600,
    maxRuntimeSeconds: 900,
    logTailChars: 80_000,
    pinnedHarnessCommit: harnessCommit,
    pinnedHarnessBuildSha256: harnessBuildSha256,
    enforceHarnessPin: true,
    enforceHarnessBuildHash: true,
    requireCleanRepoAtStart: true,
    allowDirtyHarnessCheckout: false,
    controller: { requirePlan: true, preferMinimalHarness: true, splitMemory: { enabled: true, minSamplesForEnforcement: 1 } },
    monitor: {
      enabled: true,
      host: "127.0.0.1",
      port: monitorPort,
      autoStart: true,
      charsPerEstimatedToken: 4,
      pricingAsOf: "real smoke local estimate",
      pricing: {},
      currency: { primary: "CNY", showUsd: false, usdToCnyRate: null, fxAsOf: "not-configured", fxSource: "manual" },
    },
    provider: {
      baseUrl: process.env.CODEX_REAL_SMOKE_PROVIDER_BASE_URL ?? priorBaseUrl ?? "https://api.deepseek.com",
      apiKeyFile: providerKeyPath,
    },
    harnessIsolation: {
      bubblewrapBinary: bwrapIdentity.realpath,
      bubblewrapSha256: bwrapIdentity.sha256,
      relayPort: 43_128,
      rejectEnvFiles: true,
      resourceProfile,
    },
    llamaCpp: { enabled: false, fallbackEnabled: false },
  }, null, 2)}\n`, { mode: 0o600 });

  const rendered = await runProcess("python3", [
    path.join(packageRoot, "scripts", "render-minimal-harness.py"),
    "install",
    "--template-root", path.join(packageRoot, "harness", "minimal"),
    "--profile-dir", path.join(dshHome, "profiles", "codex-minimal-headless"),
    "--preset-dir", path.join(dshHome, ".agent-presets", "codex-bridge-minimal"),
    "--runtime", packageRoot,
    "--config", configPath,
  ], { timeoutMs: 30_000, maxCaptureChars: 200_000 });
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);

  process.env.CODEX_HARNESS_CONFIG = configPath;
  process.env.DSH_HOME = dshHome;
  delete process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_API_KEY = "parent-provider-secret-must-not-reach-harness";
  process.env.GITHUB_TOKEN = "parent-github-secret-must-not-reach-harness";
  const loadedConfig = await loadConfig();
  const resourceProbes: Record<string, Awaited<ReturnType<typeof probeHostResourceProfile>>> = {};
  for (const id of RESOURCE_PROFILE_IDS) {
    const resourceProbe = await probeHostResourceProfile(loadedConfig, freezeHostResourceProfile(loadedConfig, id));
    resourceProbes[id] = resourceProbe;
    assert.equal(resourceProbe.controlledUseAllowed, true, `real Provider qualification requires controlled host resources for ${id}: ${JSON.stringify(resourceProbe)}`);
  }
  monitorStarted = true;
  const flash = await runLeaf(repo, seed, {
    planId: "stable-real-flash-multiturn-plan",
    leafId: "real-flash-multiturn",
    taskId: "stable-real-flash-multiturn-task",
    model: "deepseek-v4-flash",
    targetPath: "real-flash-multiturn.txt",
    expectedThinking: "disabled",
    minimumRequests: 4,
    minimumToolCalls: 2,
    minimumNativeToolCalls: 2,
  });
  const pro = await runLeaf(repo, seed, {
    planId: "stable-real-pro-thinking-plan",
    leafId: "real-pro-thinking",
    taskId: "stable-real-pro-thinking-task",
    model: "deepseek-v4-pro",
    targetPath: "real-pro-thinking.txt",
    expectedThinking: "enabled",
    minimumRequests: 3,
    minimumToolCalls: 1,
    minimumNativeToolCalls: 0,
  });
  const mainHeadAfter = await git(repo, ["rev-parse", "HEAD"]);
  const mainStatus = await git(repo, ["status", "--porcelain=v1"]);
  assert.equal(mainHeadAfter, mainHeadBefore, "smoke adoption commits must remain isolated from main");
  assert.equal(mainStatus, "", "smoke main must remain clean");
  report = {
    result: "PASS",
    version: releaseVersion,
    generatedAt: evidenceGeneratedAt,
    currentRevision: true,
    sourceCommit: gitBinding.commit,
    sourceTree: gitBinding.sourceTree,
    sourceTreeSha256: sourceBinding.sha256,
    sourceFileCount: Array.isArray(sourceBinding.files) ? sourceBinding.files.length : undefined,
    criticalSetSha256: criticalBinding.setSha256,
    criticalPathSha256: criticalBinding.entries,
    provider: "DeepSeek real API via authenticated local credential broker",
    credentialHandling: "parsed only in the parent trust domain and stored as a private 0600 broker key; Provider, Adapter-state, and tool broker use three distinct one-attempt capabilities delivered once over anonymous stdin",
    harnessNetworkBoundary: "Harness adapter has only its authenticated Unix-socket Provider route; model-visible Bash/Pwsh run in sibling private-PID/private-network Bubblewrap sandboxes without broker capabilities or sockets",
    bubblewrapSha256: bwrapIdentity.sha256,
    harnessCommit,
    harnessBuildSha256,
    hostResourceProfiles: resourceProbes,
    flash,
    pro,
    mainHeadBefore,
    mainHeadAfter,
    mainClean: true,
    pushed: false,
  };
} catch (error) {
  report = {
    ...report,
    result: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  };
  throw error;
} finally {
  if (monitorStarted) {
    try { await monitorStop(); } catch { /* task evidence remains authoritative */ }
  }
  try { await rm(providerKeyPath, { force: true }); } catch { /* never preserve the broker credential */ }
  if (evidencePath !== undefined) {
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (priorConfig === undefined) delete process.env.CODEX_HARNESS_CONFIG;
  else process.env.CODEX_HARNESS_CONFIG = priorConfig;
  if (priorDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = priorDshHome;
  if (priorBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = priorBaseUrl;
  if (priorProviderKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = priorProviderKey;
  if (priorGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = priorGithubToken;
  if (!keepRoot) await rm(temp, { recursive: true, force: true });
}
