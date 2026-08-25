import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorktree, removeWorktree } from "../git.js";
import { readChangedFile, reviewTask, verifyTask } from "../service.js";
import { createPinnedHostResourceProfile, freezeHostResourceProfile } from "../resource-controls.js";
import { sha256Executable } from "../process-identity.js";
import { createPlan, createTask, taskDirectory } from "../store.js";
import type { BridgeConfig, ControllerPlan, TaskRecord } from "../types.js";
import { runProcess } from "../util.js";
import { testConfig } from "./test-config.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("/usr/bin/git", args, { cwd, timeoutMs: 30_000, maxCaptureChars: 200_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function splitDecision() {
  return {
    memorySchemaVersion: 5 as const,
    memoryKey: "verification-isolation",
    taskFamily: "security/verification-isolation",
    memoryRevision: 0,
    sampleCount: 0,
    ignoredLegacySampleCount: 0,
    confidence: 0,
    recommendedLeafScale: 1,
    recommendedComplexity: "small" as const,
    recommendedMaxInputTokens: 100_000,
    recommendedMaxOutputTokens: 10_000,
    anomalyRate: 0,
    rationale: ["fixture"],
    chosenComplexity: "small" as const,
    chosenMaxInputTokens: 100_000,
    chosenMaxOutputTokens: 10_000,
  };
}

async function makeTask(
  config: BridgeConfig,
  repo: string,
  baseCommit: string,
  root: string,
  id: string,
  verificationCommand: string,
): Promise<TaskRecord> {
  const worktreePath = path.join(root, `${id}-worktree`);
  const branchName = `${id}-branch`;
  await createWorktree(repo, worktreePath, branchName, baseCommit);
  const now = new Date().toISOString();
  const taskDir = taskDirectory(config, id);
  const task: TaskRecord = {
    schemaVersion: 6,
    id,
    planId: `${id}-plan`,
    leafId: `${id}-leaf`,
    budgetGroupId: id,
    requestedExecutor: "harness",
    executor: "harness",
    effectiveExecutor: "harness",
    complexity: "small",
    harnessMode: "minimal",
    resourceProfile: freezeHostResourceProfile(config, "local_or_flash_trivial_small"),
    dependsOn: [],
    toolCapabilities: [],
    taskFamily: "security/verification-isolation",
    splitDecision: splitDecision(),
    mode: "implementation",
    objective: "verify a reviewed patch in a clean worktree",
    repoRoot: repo,
    baseRef: "HEAD",
    baseCommit,
    startingHeadCommit: baseCommit,
    branchName,
    worktreePath,
    harnessWritePaths: ["result.txt"],
    codexWritePaths: [],
    acceptanceCriteria: ["ignored residue cannot influence verification"],
    contextFiles: [],
    verificationCommands: [verificationCommand],
    budget: {
      gatePolicy: "input_output_tokens",
      ceilingPolicy: "operator_bounded",
      enforcement: "hard",
      maxApiCalls: 1,
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostCny: 1,
      maxCostUsd: 1,
    },
    status: "completed",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    runtimeSeconds: 30,
    promptPath: path.join(taskDir, "prompt.md"),
    stdoutPath: path.join(taskDir, "stdout.log"),
    stderrPath: path.join(taskDir, "stderr.log"),
    usagePath: path.join(taskDir, "usage.ndjson"),
    changedPaths: [],
    outOfScopePaths: [],
  };
  const leaf = {
    id: task.leafId,
    objective: task.objective,
    requestedExecutor: task.requestedExecutor,
    executor: task.executor,
    routingReason: "fixture",
    complexity: task.complexity,
    harnessMode: task.harnessMode,
    resourceProfile: task.resourceProfile!,
    dependsOn: [],
    toolCapabilities: [],
    taskFamily: task.taskFamily,
    splitRationale: "fixture",
    splitDecision: task.splitDecision,
    mode: "implementation" as const,
    harnessWritePaths: task.harnessWritePaths,
    codexWritePaths: [],
    acceptanceCriteria: task.acceptanceCriteria,
    contextFiles: [],
    verificationCommands: task.verificationCommands,
    runtimeSeconds: 30,
    budget: task.budget,
    status: "completed" as const,
    activeTaskId: id,
    completedTaskId: id,
  };
  const plan: ControllerPlan = {
    schemaVersion: 6,
    id: task.planId,
    repoRoot: repo,
    baseRef: "HEAD",
    baseCommit,
    createdAt: now,
    updatedAt: now,
    status: "running",
    userRequestedLlamaCpp: false,
    planHash: "0".repeat(64),
    leaves: [leaf],
    splitMemoryApplied: false,
  };
  await createPlan(config, plan);
  await createTask(config, task);
  await writeFile(path.join(worktreePath, "result.txt"), `${"reviewed-result-".repeat(48)}\n`);
  await mkdir(path.join(worktreePath, ".cache"), { recursive: true });
  await writeFile(path.join(worktreePath, ".cache", "poison"), "ignored false-pass artifact\n");
  await assert.rejects(
    reviewTask(id, "approved", ["result.txt"], "must not approve unread content"),
    /complete paginated read receipts/u,
  );
  const first = await readChangedFile(id, "result.txt", 0, 256) as { nextOffsetBytes: number | null; receipt: { complete: boolean } };
  assert.equal(first.receipt.complete, false);
  await assert.rejects(
    reviewTask(id, "approved", ["result.txt"], "must not approve partially read content"),
    /complete paginated read receipts/u,
  );
  let offset = first.nextOffsetBytes;
  while (offset !== null) {
    const page = await readChangedFile(id, "result.txt", offset, 256) as { nextOffsetBytes: number | null; receipt: { complete: boolean } };
    offset = page.nextOffsetBytes;
    if (offset === null) assert.equal(page.receipt.complete, true);
  }
  await writeFile(path.join(worktreePath, "result.txt"), `${"reviewed-result-".repeat(48)}changed\n`);
  await assert.rejects(
    reviewTask(id, "approved", ["result.txt"], "must not approve a change made after reading"),
    /complete paginated read receipts/u,
  );
  offset = 0;
  while (offset !== null) {
    const page = await readChangedFile(id, "result.txt", offset, 256) as { nextOffsetBytes: number | null; receipt: { complete: boolean } };
    offset = page.nextOffsetBytes;
    if (offset === null) assert.equal(page.receipt.complete, true);
  }
  await reviewTask(id, "approved", ["result.txt"], "reviewed fixture patch");
  return task;
}

test("authoritative verification excludes ignored false-pass artifacts and removes its worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-verification-isolation-"));
  const repo = path.join(root, "repo");
  const stateRoot = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const previousConfig = process.env.CODEX_HARNESS_CONFIG;
  let falsePassTask: TaskRecord | undefined;
  let cleanPassTask: TaskRecord | undefined;
  try {
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "verification@example.invalid"]);
    await git(repo, ["config", "user.name", "Verification Isolation"]);
    await writeFile(path.join(repo, ".gitignore"), ".cache/\n");
    await writeFile(path.join(repo, "README.md"), "verification fixture\n");
    await git(repo, ["add", ".gitignore", "README.md"]);
    await git(repo, ["commit", "-qm", "fixture"]);
    const baseCommit = await git(repo, ["rev-parse", "HEAD"]);
    const base = testConfig(stateRoot, { allowedRepoRoots: [root] });
    const [bwrap, resourceProfile] = await Promise.all([
      sha256Executable("/usr/bin/bwrap"),
      createPinnedHostResourceProfile("audit_only"),
    ]);
    const config = testConfig(stateRoot, {
      allowedRepoRoots: [root],
      harnessIsolation: {
        ...base.harnessIsolation,
        bubblewrapBinary: bwrap.realpath,
        bubblewrapSha256: bwrap.sha256,
        resourceProfile,
      },
    });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    process.env.CODEX_HARNESS_CONFIG = configPath;

    falsePassTask = await makeTask(config, repo, baseCommit, root, "ignored-false-pass", "test -e .cache/poison");
    const rejected = await verifyTask(falsePassTask.id, undefined, 30) as Record<string, unknown>;
    assert.equal(rejected.passed, false, JSON.stringify(rejected));
    assert.equal(rejected.cleanStart, true);
    assert.equal(rejected.sourceIgnoredResidueExcluded, 1);
    assert.equal(rejected.verificationWorktreeRemoved, true);
    assert.equal(await readFile(path.join(falsePassTask.worktreePath, ".cache", "poison"), "utf8"), "ignored false-pass artifact\n");

    cleanPassTask = await makeTask(config, repo, baseCommit, root, "ignored-clean-pass", "test -f result.txt && test ! -e .cache/poison");
    const accepted = await verifyTask(cleanPassTask.id, undefined, 30) as Record<string, unknown>;
    assert.equal(accepted.passed, true, JSON.stringify(accepted));
    assert.equal(accepted.reviewedFingerprint, accepted.verifiedFingerprint);
    assert.equal(accepted.currentFingerprint, accepted.verifiedFingerprint);
    assert.match(String(accepted.reviewedPatchSha256), /^[0-9a-f]{64}$/u);
    assert.match(String(accepted.verificationResultFingerprint), /^[0-9a-f]{64}$/u);
    assert.equal(accepted.sourceIgnoredResidueExcluded, 1);
    assert.equal(accepted.verificationWorktreeRemoved, true);
  } finally {
    if (falsePassTask) await removeWorktree(repo, falsePassTask.worktreePath, true).catch(() => undefined);
    if (cleanPassTask) await removeWorktree(repo, cleanPassTask.worktreePath, true).catch(() => undefined);
    if (previousConfig === undefined) delete process.env.CODEX_HARNESS_CONFIG;
    else process.env.CODEX_HARNESS_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
