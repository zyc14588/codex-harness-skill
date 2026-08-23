import { closeSync, openSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type {
  BridgeConfig,
  ControllerLeaf,
  ControllerPlan,
  HarnessExecutionMode,
  ProgressiveToolCapability,
  RequestedExecutor,
  ReviewDecision,
  TaskBudget,
  TaskComplexity,
  ProcessIdentity,
  TaskRecord,
} from "./types.js";
import { budgetWithin, DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL, defaultConfigPath, loadConfig, normalizeTaskBudget, resolveHarnessLauncher, sanitizedEnvironment } from "./config.js";
import {
  assertTaskWorktreeIdentity,
  binaryPatch,
  changedPaths,
  commitLog,
  createCommit,
  createWorktree,
  deleteBranch,
  environmentFilesAtCommit,
  diffStat,
  findLeaseSymlinkIntersections,
  findOutOfScope,
  gitlinkPathsAtCommit,
  gitTopLevel,
  readRepoFile,
  removeWorktree,
  resolveCommit,
  stagedPaths,
  symlinkPathsAtCommit,
  unsafeChangedGitlinkPaths,
  unsafeChangedSymlinkPaths,
  workingTreePaths,
} from "./git.js";
import {
  createPlan,
  createTask,
  listPlans,
  listTasks,
  loadPlan,
  loadTask,
  savePlan,
  saveTask,
  taskDirectory,
  taskFile,
  updatePlan,
  updateTask,
  withMutationLock,
  withWorktreeLock,
} from "./store.js";
import { buildHarnessPrompt } from "./prompt.js";
import { buildMonitorSnapshot, ensureMonitorRunning, monitorBaseUrl, pingMonitor, stopMonitor } from "./monitor.js";
import { probeLlamaCpp } from "./llama.js";
import { effectiveBudget, effectiveBudgetPolicy, effectiveLlamaConfig } from "./controls.js";
import { budgetExceededReason, budgetReferenceAlerts, usageForBudgetGroup } from "./telemetry.js";
import { adviseSplit, listSplitMemoryProfiles, recordTaskSplitOutcome, SPLIT_MEMORY_SCHEMA_VERSION } from "./split-memory.js";
import { decideWorkerLiveness } from "./worker-lifecycle.js";
import {
  assertDisjointLeases,
  boundedStringList,
  boundedText,
  ensureDir,
  isWithin,
  jsonToolResult,
  normalizeRepoRelative,
  nowIso,
  pathExists,
  runProcess,
  safeTaskId,
  sha256PathTree,
  tailText,
  validateLeasePattern,
} from "./util.js";
import { captureProcessIdentity, processIdentityMatches, signalVerifiedProcessGroup } from "./process-identity.js";
import { ensureOperatorToken, readProviderApiKey } from "./security.js";

const ACCEPTABLE_FOR_ADOPTION = new Set<TaskRecord["status"]>(["completed", "completed_no_changes"]);
const MAX_TASK_PROMPT_BYTES = 96_000;
const WORKER_ORPHAN_GRACE_MS = 2_000;

async function canonicalExisting(target: string, field: string): Promise<string> {
  try {
    return await realpath(path.resolve(target));
  } catch (error) {
    throw new Error(`${field} does not exist or cannot be resolved: ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureAllowedRepo(config: BridgeConfig, candidate: string): Promise<string> {
  const canonicalCandidate = await canonicalExisting(candidate, "repoRoot");
  const roots: string[] = [];
  for (const configuredRoot of config.allowedRepoRoots) {
    roots.push(await canonicalExisting(configuredRoot, "allowedRepoRoot"));
  }
  if (!roots.some((root) => isWithin(canonicalCandidate, root))) {
    throw new Error(`repoRoot is outside allowedRepoRoots: ${canonicalCandidate}`);
  }
  return canonicalCandidate;
}

function validateRuntime(config: BridgeConfig, seconds?: number): number {
  const value = seconds ?? config.defaultRuntimeSeconds;
  if (!Number.isInteger(value) || value < 60 || value > config.maxRuntimeSeconds) {
    throw new Error(`runtimeSeconds must be an integer from 60 to ${config.maxRuntimeSeconds}`);
  }
  return value;
}

async function harnessRevision(config: BridgeConfig): Promise<{
  pinned?: string;
  current?: string;
  matches: boolean;
  enforced: boolean;
  trackedDirty?: boolean;
  dirtyAllowed: boolean;
  error?: string;
}> {
  if (!config.pinnedHarnessCommit) {
    return {
      matches: !config.enforceHarnessPin,
      enforced: config.enforceHarnessPin,
      dirtyAllowed: config.allowDirtyHarnessCheckout,
      error: "pinnedHarnessCommit is not configured",
    };
  }
  const result = await runProcess("git", ["-C", config.harnessRoot, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    return {
      pinned: config.pinnedHarnessCommit,
      matches: false,
      enforced: config.enforceHarnessPin,
      dirtyAllowed: config.allowDirtyHarnessCheckout,
      error: result.stderr || "Harness root is not a readable Git checkout",
    };
  }
  const dirty = await runProcess(
    "git",
    ["-C", config.harnessRoot, "status", "--porcelain=v1", "--untracked-files=no"],
    { timeoutMs: 10_000 },
  );
  if (dirty.code !== 0) {
    return {
      pinned: config.pinnedHarnessCommit,
      current: result.stdout.trim(),
      matches: false,
      enforced: config.enforceHarnessPin,
      dirtyAllowed: config.allowDirtyHarnessCheckout,
      error: dirty.stderr || "cannot inspect Harness tracked worktree state",
    };
  }
  const current = result.stdout.trim();
  const trackedDirty = dirty.stdout.trim().length > 0;
  const matches = current === config.pinnedHarnessCommit && (config.allowDirtyHarnessCheckout || !trackedDirty);
  return {
    pinned: config.pinnedHarnessCommit,
    current,
    matches,
    enforced: config.enforceHarnessPin,
    trackedDirty,
    dirtyAllowed: config.allowDirtyHarnessCheckout,
  };
}

async function harnessBuildIntegrity(
  config: BridgeConfig,
  launcherSource?: string,
): Promise<{ expected?: string; current?: string; buildRoot?: string; matches: boolean; enforced: boolean; error?: string }> {
  const enforced = config.enforceHarnessBuildHash;
  if (!config.pinnedHarnessBuildSha256) {
    return { matches: !enforced, enforced, error: "pinnedHarnessBuildSha256 is not configured" };
  }
  try {
    const launcher = launcherSource ? { source: launcherSource } : await resolveHarnessLauncher(config);
    const buildRoot = await canonicalExisting(config.harnessBuildRoot ?? path.dirname(launcher.source), "harnessBuildRoot");
    if (config.enforceHarnessPin) {
      const harnessRoot = await canonicalExisting(config.harnessRoot, "harnessRoot");
      if (!isWithin(buildRoot, harnessRoot)) {
        throw new Error(`Harness build root must resolve inside harnessRoot: ${buildRoot}`);
      }
    }
    const current = await sha256PathTree(buildRoot);
    return {
      expected: config.pinnedHarnessBuildSha256,
      current,
      buildRoot,
      matches: current === config.pinnedHarnessBuildSha256,
      enforced,
    };
  } catch (error) {
    return {
      expected: config.pinnedHarnessBuildSha256,
      matches: false,
      enforced,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function assertHarnessProvenance(config: BridgeConfig): Promise<Awaited<ReturnType<typeof resolveHarnessLauncher>>> {
  const revision = await harnessRevision(config);
  if (config.enforceHarnessPin && !revision.matches) {
    throw new Error(`Harness revision gate failed: ${JSON.stringify(revision)}`);
  }
  const launcher = await resolveHarnessLauncher(config);
  const build = await harnessBuildIntegrity(config, launcher.source);
  if (config.enforceHarnessBuildHash && !build.matches) {
    throw new Error(`Harness build hash gate failed: ${JSON.stringify(build)}`);
  }
  return launcher;
}

async function spawnWorker(config: BridgeConfig, task: TaskRecord): Promise<number> {
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  const dir = taskDirectory(config, task.id);
  const workerLog = path.join(dir, "worker.log");
  const activationPath = path.join(dir, "worker.start");
  const readyPath = path.join(dir, "worker.ready");
  const maxAttempts = 2;
  let lastFailure = "worker did not acknowledge startup";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rm(activationPath, { force: true });
    await rm(readyPath, { force: true });
    const logFd = openSync(workerLog, "a", 0o600);
    const env = { ...sanitizedEnvironment(config), CODEX_HARNESS_CONFIG: defaultConfigPath() };
    const child = spawn(process.execPath, [workerPath, task.id, activationPath, readyPath], {
      detached: true,
      env,
      stdio: ["ignore", logFd, logFd],
    });
    let spawnedIdentity: ProcessIdentity | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const workerPid = child.pid;
      if (!workerPid) throw new Error("worker spawned without a PID");
      const workerIdentity = await captureProcessIdentity(workerPid);
      spawnedIdentity = workerIdentity;
      if (workerIdentity.processGroupId !== workerIdentity.pid) throw new Error("worker did not become its process-group leader");
      await updateTask(config, task.id, (current) => {
        if (current.status !== "queued" && current.status !== "cancelled") {
          throw new Error(`cannot publish worker PID over status ${current.status}`);
        }
        current.workerPid = workerPid;
        current.workerIdentity = workerIdentity;
        delete current.workerDeadObservedAt;
      });
      await writeFile(activationPath, `${workerPid}\n`, { mode: 0o600 });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await pathExists(readyPath)) {
          child.unref();
          return workerPid;
        }
        const current = await loadTask(config, task.id);
        if (current.status !== "queued") {
          if (current.status === "running" && current.workerPid === workerPid) {
            // The task record is the authoritative ownership receipt.  The
            // ready file is diagnostic redundancy and may lag its atomic task
            // publication by one filesystem turn.
            child.unref();
            return workerPid;
          }
          throw new Error(`worker bootstrap ended in task status ${current.status}: ${current.error ?? "no error detail"}`);
        }
        if (!await processIdentityMatches(workerIdentity)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const current = await loadTask(config, task.id);
      const logTail = await tailText(workerLog, 8_000);
      lastFailure = `worker bootstrap attempt ${attempt} exited before publishing readiness${logTail ? `: ${logTail}` : ""}`;
      if (current.status !== "queued") throw new Error(`${lastFailure}; task status is ${current.status}`);
      await updateTask(config, task.id, (latest) => {
        if (latest.status !== "queued") throw new Error(`cannot retry worker bootstrap over status ${latest.status}`);
        if (latest.workerPid === workerPid) delete latest.workerPid;
        if (latest.workerIdentity?.startTimeTicks === workerIdentity.startTimeTicks) delete latest.workerIdentity;
        delete latest.workerDeadObservedAt;
      });
      if (attempt === maxAttempts) throw new Error(lastFailure);
    } catch (error) {
      const currentIdentity = spawnedIdentity ?? (child.pid ? (await loadTask(config, task.id)).workerIdentity : undefined);
      if (currentIdentity && await processIdentityMatches(currentIdentity)) {
        await signalVerifiedProcessGroup(currentIdentity, "SIGTERM");
      } else if (!spawnedIdentity) {
        // Capture failed immediately after this ChildProcess was created; the
        // handle, rather than an old persisted PID, is the remaining authority.
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      if (attempt === maxAttempts) throw error;
      const current = await loadTask(config, task.id);
      if (current.status !== "queued") throw error;
      await updateTask(config, task.id, (latest) => {
        if (latest.status !== "queued") throw new Error(`cannot retry worker bootstrap over status ${latest.status}`);
        if (latest.workerPid === child.pid) delete latest.workerPid;
        if (latest.workerIdentity?.pid === child.pid) delete latest.workerIdentity;
        delete latest.workerDeadObservedAt;
      });
      lastFailure = error instanceof Error ? error.message : String(error);
    } finally {
      closeSync(logFd);
    }
  }
  throw new Error(lastFailure);
}

async function changeFingerprint(task: TaskRecord): Promise<string> {
  await assertTaskWorktreeIdentity(task);
  const patch = await binaryPatch(task.worktreePath, task.baseCommit);
  const paths = await changedPaths(task.worktreePath, task.baseCommit);
  return createHash("sha256")
    .update(task.baseCommit).update("\0")
    .update(paths.join("\0")).update("\0")
    .update(patch)
    .digest("hex");
}

function terminal(task: TaskRecord): boolean {
  return task.status !== "queued" && task.status !== "running";
}

function publicTaskSummary(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    planId: task.planId,
    leafId: task.leafId,
    parentTaskId: task.parentTaskId,
    budgetGroupId: task.budgetGroupId,
    requestedExecutor: task.requestedExecutor ?? task.executor,
    executor: task.executor,
    effectiveExecutor: task.effectiveExecutor ?? task.executor,
    routingReason: task.routingReason,
    fallbackUsed: task.fallbackUsed ?? false,
    fallbackReason: task.fallbackReason,
    fallbackModel: task.fallbackModel,
    complexity: task.complexity,
    harnessMode: task.harnessMode,
    parallelGroup: task.parallelGroup,
    dependsOn: task.dependsOn,
    toolCapabilities: task.toolCapabilities,
    taskFamily: task.taskFamily,
    splitDecision: task.splitDecision,
    mode: task.mode,
    status: task.status,
    objective: task.objective,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    changedPaths: task.changedPaths,
    outOfScopePaths: task.outOfScopePaths,
    reviewDecision: task.reviewDecision,
    reviewedFingerprint: task.reviewedFingerprint,
    verificationPassed: task.verificationPassed,
    verifiedFingerprint: task.verifiedFingerprint,
    bridgeCommit: task.bridgeCommit,
    dashboardUrl: task.dashboardUrl,
    worktreeRemoved: task.worktreeRemoved ?? false,
    branchDeleted: task.branchDeleted ?? false,
    referenceAlerts: task.referenceAlerts ?? [],
    toolProtocolRecoveryCount: task.toolProtocolRecoveryCount ?? 0,
    toolProtocolRecoveryKinds: task.toolProtocolRecoveryKinds ?? [],
    toolProtocolRecoveredTools: task.toolProtocolRecoveredTools ?? [],
    toolProtocolNativeCallCount: task.toolProtocolNativeCallCount ?? 0,
    toolProtocolNativeTools: task.toolProtocolNativeTools ?? [],
    minimalMutationForceCount: task.minimalMutationForceCount ?? 0,
    minimalMutationForcedTools: task.minimalMutationForcedTools ?? [],
    minimalMutationPolicyVersion: task.minimalMutationPolicyVersion,
    minimalMutationLastAt: task.minimalMutationLastAt,
    minimalMutationAuxiliaryBypassCount: task.minimalMutationAuxiliaryBypassCount ?? 0,
    minimalMutationAuxiliaryBypassKinds: task.minimalMutationAuxiliaryBypassKinds ?? [],
    minimalMutationAuxiliaryLastAt: task.minimalMutationAuxiliaryLastAt,
    minimalRequestPhase: task.minimalRequestPhase,
    minimalRunnerPresetId: task.minimalRunnerPresetId,
    minimalRunnerVisibleTools: task.minimalRunnerVisibleTools ?? [],
    minimalAssembledTools: task.minimalAssembledTools ?? [],
    minimalCoreMutationTools: task.minimalCoreMutationTools ?? [],
    minimalRunnerSnapshotAt: task.minimalRunnerSnapshotAt,
    minimalPrimaryMutationArmedAt: task.minimalPrimaryMutationArmedAt,
    minimalRequestOrdinal: task.minimalRequestOrdinal ?? 0,
    minimalRequestEvidence: task.minimalRequestEvidence ?? [],
    providerRequestOrdinal: task.providerRequestOrdinal ?? 0,
    thinkingRequestEvidence: task.thinkingRequestEvidence ?? [],
    reasoningReplayRequirements: task.reasoningReplayRequirements ?? [],
    thinkingPolicyFailureAt: task.thinkingPolicyFailureAt,
    toolProtocolFailure: task.toolProtocolFailure,
    toolProtocolFailureAt: task.toolProtocolFailureAt,
    infrastructureFailureKind: task.infrastructureFailureKind,
    infrastructureFailureDetails: task.infrastructureFailureDetails,
    splitOutcomeRevision: task.splitOutcomeRevision,
    error: task.error,
  };
}

function validatedHarnessUpstreamBaseUrl(config: BridgeConfig): string {
  const raw = config.provider.baseUrl.trim().replace(/\/+$/, "");
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("provider.baseUrl must be a valid absolute URL"); }
  if (value.protocol !== "http:" && value.protocol !== "https:") throw new Error("provider.baseUrl must use http or https");
  if (value.username || value.password) throw new Error("provider.baseUrl must not embed credentials");
  const monitor = new URL(monitorBaseUrl(config));
  if (value.origin === monitor.origin) throw new Error("DEEPSEEK_BASE_URL must not point at the bridge monitor; recursive proxying is forbidden");
  return raw;
}

async function terminateRecordedProcess(identity?: ProcessIdentity): Promise<void> {
  if (!identity || identity.pid === process.pid) return;
  if (!await signalVerifiedProcessGroup(identity, "SIGTERM")) return;
  const escalation = setTimeout(() => { void signalVerifiedProcessGroup(identity, "SIGKILL"); }, 5_000);
  escalation.unref();
}

async function assertWorktreeIdle(config: BridgeConfig, worktreePath: string): Promise<void> {
  const active = (await listTasks(config)).find(
    (candidate) => candidate.worktreePath === worktreePath && (candidate.status === "queued" || candidate.status === "running"),
  );
  if (active) throw new Error(`worktree has active task ${active.id}`);
}

function expectedTaskHead(task: TaskRecord): string {
  return task.bridgeCommit ?? task.startingHeadCommit ?? task.baseCommit;
}

async function assertTaskHeadExpected(task: TaskRecord, operation: string): Promise<string> {
  const current = await resolveCommit(task.worktreePath, "HEAD");
  const expected = expectedTaskHead(task);
  if (current !== expected) {
    throw new Error(`${operation} refuses unexpected Git HEAD ${current}; expected ${expected}. Harness and verification commands must not create commits.`);
  }
  return current;
}

function assertAdoptableStatus(task: TaskRecord, operation: string): void {
  if (!ACCEPTABLE_FOR_ADOPTION.has(task.status)) {
    throw new Error(`${operation} requires completed or completed_no_changes status; current status is ${task.status}`);
  }
}

function checkedHarnessPrompt(task: TaskRecord, repairFeedback?: string): string {
  const prompt = buildHarnessPrompt(task, repairFeedback);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_TASK_PROMPT_BYTES) {
    throw new Error(`Harness task contract exceeds ${MAX_TASK_PROMPT_BYTES} UTF-8 bytes; reduce objective, context files, or acceptance criteria`);
  }
  return prompt;
}

function validateBudgetAgainstMaximum(
  defaults: TaskBudget,
  maximum: TaskBudget,
  requested?: Partial<TaskBudget>,
): TaskBudget {
  const budget = {
    ...normalizeTaskBudget(requested, defaults, "leaf.budget"),
    gatePolicy: "input_output_tokens" as const,
    ceilingPolicy: "operator_bounded" as const,
    enforcement: "hard" as const,
  };
  if (!budgetWithin(budget, maximum)) {
    throw new Error(`leaf budget exceeds controller maximum: ${JSON.stringify(maximum)}`);
  }
  return budget;
}

function validateProComplexBudget(defaults: TaskBudget, requested?: Partial<TaskBudget>): TaskBudget {
  return {
    ...normalizeTaskBudget(requested, defaults, "leaf.budget"),
    gatePolicy: "input_output_tokens",
    ceilingPolicy: "unbounded",
    enforcement: "hard",
  };
}

function planFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactLlamaLeases(leases: string[]): void {
  if (leases.some((lease) => lease === "**" || lease.endsWith("/**"))) {
    throw new Error("llama.cpp leaves require exact file leases and cannot use /** or **");
  }
}

export interface ControllerLeafInput {
  id: string;
  objective: string;
  executor?: RequestedExecutor;
  complexity: "trivial" | "small" | "medium" | "large";
  mode?: "implementation" | "test" | "review" | "analysis";
  harnessMode?: HarnessExecutionMode;
  parallelGroup?: string;
  dependsOn?: string[];
  toolCapabilities?: ProgressiveToolCapability[];
  taskFamily?: string;
  splitRationale?: string;
  memoryOverrideReason?: string;
  harnessWritePaths: string[];
  codexWritePaths?: string[];
  acceptanceCriteria: string[];
  contextFiles?: string[];
  verificationCommands: string[];
  runtimeSeconds?: number;
  model?: string;
  budget?: Partial<TaskBudget>;
}

export interface CreateControllerPlanInput {
  repoRoot: string;
  leaves: ControllerLeafInput[];
  baseRef?: string;
  planId?: string;
  userRequestedLlamaCpp?: boolean;
}

function localRoutingEligible(
  input: ControllerLeafInput,
  leases: string[],
  llama: Awaited<ReturnType<typeof effectiveLlamaConfig>>,
  requestedModel: string | undefined,
): boolean {
  return llama.enabled && llama.autoRouteSimpleLeaves &&
    (!requestedModel || requestedModel === llama.model) &&
    (input.complexity === "trivial" || input.complexity === "small") &&
    leases.length <= llama.maxFilesPerTask &&
    leases.every((lease) => lease !== "**" && !lease.endsWith("/**"));
}

const PROGRESSIVE_CAPABILITIES = new Set<ProgressiveToolCapability>(["repository_read", "verification", "git_inspect"]);
const COMPLEXITY_ORDER: TaskComplexity[] = ["trivial", "small", "medium", "large"];

function complexityRank(value: TaskComplexity): number {
  return COMPLEXITY_ORDER.indexOf(value);
}

function defaultTaskFamily(mode: string, leases: string[], executor: string, model?: string): string {
  // Default memory transfer stays conservative: unrelated leaves under a broad
  // top-level directory must not inherit one another's anomaly history. Teams
  // that want semantic cross-file learning can provide an explicit taskFamily.
  const scopes = leases.slice(0, 3).map((lease) => {
    const clean = lease.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\*\*$/, "root");
    const parts = clean.split("/").filter(Boolean);
    return parts.slice(0, Math.min(3, parts.length)).join("/") || "root";
  }).sort().join("|");
  return `${mode}:${scopes || "root"}:${executor}:${model ?? "default"}`;
}

function normalizeToolCapabilities(value: ProgressiveToolCapability[] | undefined, minimal: boolean): ProgressiveToolCapability[] {
  const selected = value ?? (minimal ? ["repository_read", "verification", "git_inspect"] : []);
  const unique = [...new Set(selected)];
  for (const capability of unique) {
    if (!PROGRESSIVE_CAPABILITIES.has(capability)) throw new Error(`unsupported progressive tool capability: ${capability}`);
  }
  return unique;
}

async function normalizedLeaf(
  config: BridgeConfig,
  repoRoot: string,
  defaults: TaskBudget,
  maximum: TaskBudget,
  proComplexDefaults: TaskBudget,
  llama: Awaited<ReturnType<typeof effectiveLlamaConfig>>,
  input: ControllerLeafInput,
): Promise<ControllerLeaf> {
  const id = safeTaskId(input.id);
  const complexity = input.complexity;
  const requestedExecutor = input.executor ?? "auto";
  const requestedModel = input.model?.trim() ? boundedText(input.model.trim(), `leaf ${id} model`, 512) : undefined;
  const harnessWritePaths = [...new Set(input.harnessWritePaths.map(validateLeasePattern))];
  const codexWritePaths = [...new Set((input.codexWritePaths ?? []).map(validateLeasePattern))];
  if (!harnessWritePaths.length) throw new Error(`leaf ${id} requires at least one worker write lease`);
  if (harnessWritePaths.length > config.controller.maxHarnessWriteLeases) {
    throw new Error(`leaf ${id} exceeds ${config.controller.maxHarnessWriteLeases} write leases; decompose it`);
  }
  if (harnessWritePaths.includes("**")) throw new Error(`leaf ${id} cannot lease the entire repository`);
  assertDisjointLeases(harnessWritePaths, codexWritePaths);

  let executor: "harness" | "llama_cpp";
  let routingReason: string;
  if (requestedExecutor === "llama_cpp") {
    if (!llama.enabled) throw new Error(`leaf ${id}: llama.cpp was explicitly selected but is disabled in operator controls`);
    if (complexity !== "trivial" && complexity !== "small") throw new Error(`leaf ${id}: llama.cpp is restricted to trivial or small leaves`);
    exactLlamaLeases(harnessWritePaths);
    executor = "llama_cpp";
    routingReason = "explicit llama.cpp request accepted by enabled operator control";
  } else if (requestedExecutor === "auto" && localRoutingEligible(input, harnessWritePaths, llama, requestedModel)) {
    executor = "llama_cpp";
    routingReason = `auto-routed to llama.cpp (${llama.mode}); Harness ${llama.fallbackModel} is the controlled fallback`;
  } else {
    executor = "harness";
    routingReason = requestedExecutor === "harness"
      ? "explicit Harness request"
      : llama.enabled
        ? "auto routing selected Harness because the leaf is not an exact-file trivial/small local task"
        : "auto routing selected Harness because llama.cpp is disabled";
  }

  // A Harness attempt must have a model before its immutable thinking policy
  // is frozen. Preserve explicit Pro/custom selection; default Harness leaves
  // to the governed Flash route instead of inheriting mutable global state.
  const selectedModel = executor === "harness" ? requestedModel ?? DEEPSEEK_FLASH_MODEL : requestedModel;

  const proComplexLeaf = executor === "harness" && complexity === "large" && selectedModel === DEEPSEEK_PRO_MODEL;
  if (executor === "harness" && complexity === "large" && !proComplexLeaf) {
    throw new Error(`leaf ${id} is marked large; only Harness pinned to ${DEEPSEEK_PRO_MODEL} may receive a complex leaf. Codex must keep local/Flash work at the existing decomposition granularity`);
  }
  if (proComplexLeaf) {
    routingReason = `complex Harness leaf accepted because model is pinned to ${DEEPSEEK_PRO_MODEL}; it uses high frozen input/output token gates without a compiled operator ceiling`;
  }
  if (executor === "llama_cpp") exactLlamaLeases(harnessWritePaths);

  const mode = input.mode ?? "implementation";
  const harnessMode: HarnessExecutionMode = executor === "harness"
    ? input.harnessMode ?? (config.controller.preferMinimalHarness ? "minimal" : "standard")
    : "standard";
  const toolCapabilities = normalizeToolCapabilities(input.toolCapabilities, executor === "harness" && harnessMode === "minimal");
  if (harnessMode !== "minimal" && toolCapabilities.length > 0) {
    throw new Error(`leaf ${id}: progressive tool capabilities are available only in Harness minimal mode`);
  }
  const parallelGroup = input.parallelGroup?.trim()
    ? boundedText(input.parallelGroup.trim(), `leaf ${id} parallelGroup`, 200)
    : undefined;
  const dependsOn = [...new Set((input.dependsOn ?? []).map(safeTaskId))];
  if (dependsOn.includes(id)) throw new Error(`leaf ${id} cannot depend on itself`);
  const taskFamily = boundedText(
    input.taskFamily?.trim() || defaultTaskFamily(mode, harnessWritePaths, executor, selectedModel),
    `leaf ${id} taskFamily`,
    500,
  );
  const splitRationale = boundedText(
    input.splitRationale?.trim() || "Codex selected this bounded leaf from the frozen objective, write lease, model tier, and verification contract.",
    `leaf ${id} splitRationale`,
    8_000,
  );

  const defaultBudget = proComplexLeaf ? proComplexDefaults : defaults;
  const advice = await adviseSplit(config, repoRoot, {
    taskFamily,
    requestedExecutor,
    executor,
    ...(selectedModel ? { model: selectedModel } : {}),
    harnessMode,
    mode,
    proposedComplexity: complexity,
    defaultBudget,
  });
  const memoryOverrideReason = input.memoryOverrideReason?.trim()
    ? boundedText(input.memoryOverrideReason.trim(), `leaf ${id} memoryOverrideReason`, 4_000)
    : undefined;
  if (advice.decision.confidence >= 0.5 &&
      complexityRank(complexity) > complexityRank(advice.decision.recommendedComplexity) &&
      !memoryOverrideReason) {
    throw new Error(`leaf ${id} exceeds adaptive split-memory recommendation ${advice.decision.recommendedComplexity}; split it smaller or provide memoryOverrideReason`);
  }

  const adaptiveBudget: Partial<TaskBudget> = { ...(input.budget ?? {}) };
  if (input.budget?.maxInputTokens === undefined && advice.decision.sampleCount > 0) {
    adaptiveBudget.maxInputTokens = advice.decision.recommendedMaxInputTokens;
  }
  if (input.budget?.maxOutputTokens === undefined && advice.decision.sampleCount > 0) {
    adaptiveBudget.maxOutputTokens = advice.decision.recommendedMaxOutputTokens;
  }
  const budget = proComplexLeaf
    ? validateProComplexBudget(proComplexDefaults, adaptiveBudget)
    : validateBudgetAgainstMaximum(defaults, maximum, adaptiveBudget);
  advice.decision.chosenComplexity = complexity;
  advice.decision.chosenMaxInputTokens = budget.maxInputTokens;
  advice.decision.chosenMaxOutputTokens = budget.maxOutputTokens;
  if (memoryOverrideReason) advice.decision.overrideReason = memoryOverrideReason;

  const acceptanceCriteria = boundedStringList(input.acceptanceCriteria, `leaf ${id} acceptanceCriteria`, config.controller.maxHarnessAcceptanceCriteria, 8_000);
  if (!acceptanceCriteria.length) throw new Error(`leaf ${id} requires acceptance criteria`);
  const verificationCommands = boundedStringList(input.verificationCommands, `leaf ${id} verificationCommands`, 100, 16_000);
  if (!verificationCommands.length) throw new Error(`leaf ${id} requires authoritative verification commands`);
  const contextFiles = [...new Set((input.contextFiles ?? []).map(normalizeRepoRelative))];
  if (contextFiles.length > config.controller.maxHarnessContextFiles) {
    throw new Error(`leaf ${id} exceeds ${config.controller.maxHarnessContextFiles} context files; Codex must reduce context`);
  }

  const leaf: ControllerLeaf = {
    id,
    objective: boundedText(input.objective, `leaf ${id} objective`, config.controller.maxHarnessObjectiveChars),
    requestedExecutor,
    executor,
    routingReason,
    complexity,
    harnessMode,
    ...(parallelGroup ? { parallelGroup } : {}),
    dependsOn,
    toolCapabilities,
    taskFamily,
    splitRationale,
    splitDecision: advice.decision,
    mode,
    harnessWritePaths,
    codexWritePaths,
    acceptanceCriteria,
    contextFiles,
    verificationCommands,
    runtimeSeconds: validateRuntime(config, input.runtimeSeconds),
    budget,
    status: "planned",
  };
  if (selectedModel) leaf.model = selectedModel;
  return leaf;
}

function validateLeafDependencies(leaves: ControllerLeaf[]): void {
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  for (const leaf of leaves) {
    for (const dependency of leaf.dependsOn) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`leaf ${leaf.id} depends on unknown leaf ${dependency}`);
      if (leaf.parallelGroup && target.parallelGroup === leaf.parallelGroup) {
        throw new Error(`leaf ${leaf.id} cannot depend on ${dependency} inside the same parallelGroup ${leaf.parallelGroup}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`controller leaf dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const leaf of leaves) visit(leaf.id);
}

export async function createControllerPlan(input: CreateControllerPlanInput): Promise<unknown> {
  const config = await loadConfig();
  return await withMutationLock(config, async () => {
    const requestedRoot = await ensureAllowedRepo(config, input.repoRoot);
    const repoRoot = await ensureAllowedRepo(config, await gitTopLevel(requestedRoot));
    if (config.requireCleanRepoAtStart) {
      const dirty = await workingTreePaths(repoRoot);
      if (dirty.length) throw new Error(`repository must be clean while freezing the controller base commit: ${dirty.slice(0, 20).join(", ")}`);
    }
    if (!Array.isArray(input.leaves) || input.leaves.length < 1 || input.leaves.length > config.controller.maxLeavesPerPlan) {
      throw new Error(`controller plan must contain 1-${config.controller.maxLeavesPerPlan} leaves`);
    }
    const policy = await effectiveBudgetPolicy(config);
    const llama = await effectiveLlamaConfig(config);
    const leaves = await Promise.all(input.leaves.map(async (leaf) => await normalizedLeaf(
      config,
      repoRoot,
      policy.defaultHarnessBudget,
      policy.maximumHarnessBudget,
      policy.defaultProComplexBudget,
      llama,
      leaf,
    )));
    if (new Set(leaves.map((leaf) => leaf.id)).size !== leaves.length) throw new Error("controller leaf IDs must be unique");
    validateLeafDependencies(leaves);
    const allHarness = leaves.flatMap((leaf) => leaf.harnessWritePaths);
    const allCodex = leaves.flatMap((leaf) => leaf.codexWritePaths);
    assertDisjointLeases(allHarness, allCodex);
    for (let left = 0; left < leaves.length; left += 1) {
      for (let right = left + 1; right < leaves.length; right += 1) {
        assertDisjointLeases(leaves[left]!.harnessWritePaths, leaves[right]!.harnessWritePaths);
      }
    }
    const baseRef = boundedText(input.baseRef ?? "HEAD", "baseRef", 512);
    const baseCommit = await resolveCommit(repoRoot, baseRef);
    const id = safeTaskId(input.planId ?? `plan-${Date.now()}`);
    const localAuthorized = leaves.some((leaf) => leaf.executor === "llama_cpp");
    const immutable = { repoRoot, baseRef, baseCommit, userRequestedLlamaCpp: input.userRequestedLlamaCpp === true || localAuthorized, leaves: leaves.map(({ status: _status, ...leaf }) => leaf) };
    const now = nowIso();
    const plan: ControllerPlan = {
      schemaVersion: 6,
      id,
      repoRoot,
      baseRef,
      baseCommit,
      createdAt: now,
      updatedAt: now,
      status: "planned",
      userRequestedLlamaCpp: input.userRequestedLlamaCpp === true || localAuthorized,
      planHash: planFingerprint(immutable),
      leaves,
      splitMemoryApplied: config.controller.splitMemory.enabled,
    };
    await createPlan(config, plan);
    return {
      planId: plan.id,
      status: plan.status,
      baseCommit: plan.baseCommit,
      planHash: plan.planHash,
      userRequestedLlamaCpp: plan.userRequestedLlamaCpp,
      leaves: plan.leaves,
      splitMemoryApplied: plan.splitMemoryApplied,
      nextAction: "Launch every dependency-ready leaf whose leases are disjoint. Harness minimal leaves may run concurrently; Codex must review and verify every result independently.",
    };
  });
}

export async function controllerPlanStatus(planId: string): Promise<unknown> {
  const config = await loadConfig();
  const plan = await loadPlan(config, safeTaskId(planId));
  const taskMap = new Map((await listTasks(config)).filter((task) => task.planId === plan.id).map((task) => [task.id, task]));
  return {
    ...plan,
    leaves: plan.leaves.map((leaf) => ({
      ...leaf,
      activeTask: leaf.activeTaskId && taskMap.get(leaf.activeTaskId) ? publicTaskSummary(taskMap.get(leaf.activeTaskId)!) : undefined,
      completedTask: leaf.completedTaskId && taskMap.get(leaf.completedTaskId) ? publicTaskSummary(taskMap.get(leaf.completedTaskId)!) : undefined,
    })),
  };
}

export async function listControllerPlans(limit: number): Promise<unknown> {
  const config = await loadConfig();
  return (await listPlans(config)).slice(0, Math.max(1, Math.min(limit, 50))).map((plan) => ({
    id: plan.id, status: plan.status, repoRoot: plan.repoRoot, baseCommit: plan.baseCommit,
    createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    leaves: plan.leaves.map((leaf) => ({ id: leaf.id, executor: leaf.executor, status: leaf.status, activeTaskId: leaf.activeTaskId })),
  }));
}

export interface SplitAdviceCandidateInput {
  id: string;
  taskFamily: string;
  executor?: RequestedExecutor;
  model?: string;
  harnessMode?: HarnessExecutionMode;
  mode?: "implementation" | "test" | "review" | "analysis";
  complexity: TaskComplexity;
  proComplex?: boolean;
}

export async function controllerSplitAdvice(repoRootInput: string, candidates: SplitAdviceCandidateInput[]): Promise<unknown> {
  const config = await loadConfig();
  const requestedRoot = await ensureAllowedRepo(config, repoRootInput);
  const repoRoot = await ensureAllowedRepo(config, await gitTopLevel(requestedRoot));
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > config.controller.maxLeavesPerPlan) {
    throw new Error(`split advice requires 1-${config.controller.maxLeavesPerPlan} candidates`);
  }
  const policy = await effectiveBudgetPolicy(config);
  const advice = [];
  for (const candidate of candidates) {
    const id = safeTaskId(candidate.id);
    const requestedExecutor = candidate.executor ?? "harness";
    const executor = requestedExecutor === "llama_cpp" ? "llama_cpp" : "harness";
    const model = executor === "harness"
      ? candidate.model?.trim() || DEEPSEEK_FLASH_MODEL
      : candidate.model?.trim() || undefined;
    const harnessMode = executor === "harness"
      ? candidate.harnessMode ?? (config.controller.preferMinimalHarness ? "minimal" : "standard")
      : "standard";
    const usePro = candidate.proComplex === true || (candidate.complexity === "large" && model === DEEPSEEK_PRO_MODEL);
    const result = await adviseSplit(config, repoRoot, {
      taskFamily: boundedText(candidate.taskFamily, `candidate ${id} taskFamily`, 500),
      requestedExecutor,
      executor,
      ...(model ? { model } : {}),
      harnessMode,
      mode: candidate.mode ?? "implementation",
      proposedComplexity: candidate.complexity,
      defaultBudget: usePro ? policy.defaultProComplexBudget : policy.defaultHarnessBudget,
    });
    advice.push({ id, ...result.decision, profile: result.profile });
  }
  return {
    repoRoot,
    adaptiveMemoryEnabled: config.controller.splitMemory.enabled,
    splitMemorySchemaVersion: SPLIT_MEMORY_SCHEMA_VERSION,
    candidates: advice,
    instruction: "Codex should reduce leaf scope when recommendedLeafScale is below 1, obey recommendedComplexity at confidence >= 0.5, and record an explicit override reason when a larger leaf is necessary.",
  };
}

export async function controllerSplitMemory(repoRootInput?: string): Promise<unknown> {
  const config = await loadConfig();
  const repoRoot = repoRootInput
    ? await ensureAllowedRepo(config, await gitTopLevel(await ensureAllowedRepo(config, repoRootInput)))
    : undefined;
  return {
    enabled: config.controller.splitMemory.enabled,
    schemaVersion: SPLIT_MEMORY_SCHEMA_VERSION,
    config: config.controller.splitMemory,
    profiles: await listSplitMemoryProfiles(config, repoRoot),
  };
}

export interface MinimalCompositionInspection {
  ok: boolean;
  stockRunnerDisabled: boolean;
  bridgeRunnerMounted: boolean;
  sessionTitleDisabled: boolean;
  minimalPresetSelected: boolean;
  patchWarningFree: boolean;
  errors: string[];
}

function effectiveConfigEntry(dump: string, id: string): string | undefined {
  const lines = dump.split(/\r?\n/u);
  for (let start = 0; start < lines.length; start += 1) {
    const line = lines[start]!;
    const match = /^(\s*)-\s+id:\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^['"]|['"]$/gu, "");
    if (value !== id) continue;
    const indent = match[1]!.length;
    let end = start + 1;
    while (end < lines.length) {
      const next = /^(\s*)-\s+id:\s*(.+?)\s*$/u.exec(lines[end]!);
      if (next && next[1]!.length === indent) break;
      end += 1;
    }
    return lines.slice(start, end).join("\n");
  }
  return undefined;
}

/** Parse the effective managed profile, rather than trusting dump-config's exit code alone. */
export function inspectMinimalProfileComposition(stdout: string, stderr: string): MinimalCompositionInspection {
  const stockRunner = effectiveConfigEntry(stdout, "headless-runner");
  const bridgeRunner = effectiveConfigEntry(stdout, "codex-bridge-headless-runner");
  const sessionTitle = effectiveConfigEntry(stdout, "session-title-llm");
  const agentPresets = effectiveConfigEntry(stdout, "agent-presets");
  const stockRunnerDisabled = stockRunner !== undefined && /^\s*disabled:\s*true\s*$/mu.test(stockRunner);
  const bridgeRunnerMounted = bridgeRunner !== undefined
    && /^\s*name:\s*['"]?\.\/bridge-headless-runner\.mjs['"]?\s*$/mu.test(bridgeRunner)
    && !/^\s*disabled:\s*true\s*$/mu.test(bridgeRunner);
  const sessionTitleDisabled = sessionTitle !== undefined && /^\s*disabled:\s*true\s*$/mu.test(sessionTitle);
  const minimalPresetSelected = agentPresets !== undefined
    && /^\s*default:\s*['"]?codex-bridge-minimal['"]?\s*$/mu.test(agentPresets);
  const patchWarningFree = !/(?:name mismatch|skipping|patch.+(?:mismatch|skip))/iu.test(stderr);
  const errors: string[] = [];
  if (!stockRunnerDisabled) errors.push("effective headless-runner is not disabled");
  if (!bridgeRunnerMounted) errors.push("effective codex-bridge-headless-runner is not mounted");
  if (!sessionTitleDisabled) errors.push("effective session-title-llm is not disabled");
  if (!minimalPresetSelected) errors.push("effective agent-presets.default is not codex-bridge-minimal");
  if (!patchWarningFree) errors.push("dump-config reported a patch mismatch/skip warning");
  return {
    ok: errors.length === 0,
    stockRunnerDisabled,
    bridgeRunnerMounted,
    sessionTitleDisabled,
    minimalPresetSelected,
    patchWarningFree,
    errors,
  };
}

export async function doctor(probeHarness: boolean): Promise<unknown> {
  const config = await loadConfig();
  await ensureDir(config.stateRoot);
  const runtimeBudgetPolicy = await effectiveBudgetPolicy(config);
  const runtimeLlama = await effectiveLlamaConfig(config);
  const dshHome = config.dshHome ?? path.resolve(process.env.DSH_HOME ?? path.join(process.env.HOME ?? "", ".dsh"));
  const minimalProfilePath = path.join(dshHome, "profiles", config.harnessMinimalProfile);
  const minimalPresetPath = path.join(dshHome, ".agent-presets", "codex-bridge-minimal");
  const minimalServerPath = fileURLToPath(new URL("./minimal-tools-server.js", import.meta.url));
  const minimalRequestStatePath = fileURLToPath(new URL("./minimal-request-state.js", import.meta.url));
  const minimalIntegration = {
    profile: minimalProfilePath,
    profileExists: await pathExists(path.join(minimalProfilePath, "cordis.patch.yml")),
    profileManaged: await pathExists(path.join(minimalProfilePath, ".codex-harness-bridge-managed.json")),
    preset: minimalPresetPath,
    presetExists: await pathExists(path.join(minimalPresetPath, "agent.cordis.yml")),
    presetManaged: await pathExists(path.join(minimalPresetPath, ".codex-harness-bridge-managed.json")),
    progressiveToolServer: minimalServerPath,
    progressiveToolServerExists: await pathExists(minimalServerPath),
    requestStateModule: minimalRequestStatePath,
    requestStateModuleExists: await pathExists(minimalRequestStatePath),
  };
  const checks: Record<string, unknown> = {
    configPath: defaultConfigPath(), configReadable: true, stateRoot: config.stateRoot,
    harnessRoot: config.harnessRoot, harnessRootExists: await pathExists(config.harnessRoot),
    harnessProfiles: { standard: config.harnessProfile, minimal: config.harnessMinimalProfile },
    minimalIntegration,
    allowedRepoRoots: config.allowedRepoRoots, enforceHarnessPin: config.enforceHarnessPin,
    requireCleanRepoAtStart: config.requireCleanRepoAtStart, allowDirtyHarnessCheckout: config.allowDirtyHarnessCheckout,
    enforceHarnessBuildHash: config.enforceHarnessBuildHash, harnessBuildRoot: config.harnessBuildRoot,
    controller: { ...config.controller, runtimeBudgetPolicy }, monitor: { ...config.monitor, pricing: Object.keys(config.monitor.pricing) },
    llamaCpp: { ...runtimeLlama, apiKeyConfigured: Boolean(process.env[runtimeLlama.apiKeyEnv]) },
  };
  const node = await runProcess(process.execPath, ["--version"], { timeoutMs: 5_000 });
  const git = await runProcess("git", ["--version"], { timeoutMs: 5_000 });
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeSupported = major > 22 || (major === 22 && minor >= 12);
  checks.node = { ok: node.code === 0 && nodeSupported, version: node.stdout.trim(), required: ">=22.12.0" };
  checks.git = { ok: git.code === 0, version: git.stdout.trim() };
  const rootChecks: Array<Record<string, unknown>> = [];
  for (const root of config.allowedRepoRoots) {
    try { rootChecks.push({ root, ok: true, canonical: await realpath(root) }); }
    catch (error) { rootChecks.push({ root, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  checks.allowedRootChecks = rootChecks;
  const revision = await harnessRevision(config);
  checks.harnessRevision = revision;
  let launcherOk = false;
  let probeOk = !probeHarness;
  try {
    const launcher = await resolveHarnessLauncher(config);
    launcherOk = true;
    checks.harnessLauncher = { ok: true, ...launcher };
    const buildIntegrity = await harnessBuildIntegrity(config, launcher.source);
    checks.harnessBuildIntegrity = buildIntegrity;
    if (config.enforceHarnessBuildHash && !buildIntegrity.matches) launcherOk = false;
    if (probeHarness) {
      const version = await runProcess(launcher.command, [...launcher.prefixArgs, "--version"], { cwd: config.harnessRoot, env: sanitizedEnvironment(config), timeoutMs: 30_000 });
      const standardComposition = await runProcess(launcher.command, [...launcher.prefixArgs, "--profile", config.harnessProfile, "--dump-config"], {
        cwd: config.harnessRoot, env: sanitizedEnvironment(config), timeoutMs: 60_000, maxCaptureChars: 200_000,
      });
      const minimalComposition = await runProcess(launcher.command, [...launcher.prefixArgs, "--profile", config.harnessMinimalProfile, "--dump-config"], {
        cwd: config.harnessRoot, env: sanitizedEnvironment(config), timeoutMs: 60_000, maxCaptureChars: 200_000,
      });
      const minimalStructureOk = minimalIntegration.profileExists && minimalIntegration.profileManaged
        && minimalIntegration.presetExists && minimalIntegration.presetManaged
        && minimalIntegration.progressiveToolServerExists && minimalIntegration.requestStateModuleExists;
      const minimalEffectiveComposition = inspectMinimalProfileComposition(minimalComposition.stdout, minimalComposition.stderr);
      probeOk = version.code === 0 && standardComposition.code === 0 && minimalComposition.code === 0
        && minimalStructureOk && minimalEffectiveComposition.ok;
      checks.harnessProbe = {
        ok: probeOk,
        version: { code: version.code, stdout: version.stdout.trim(), stderr: version.stderr.trim() },
        standardProfileComposition: { code: standardComposition.code, stdoutChars: standardComposition.stdout.length, stderrChars: standardComposition.stderr.length },
        minimalProfileComposition: { code: minimalComposition.code, stdoutChars: minimalComposition.stdout.length, stderrChars: minimalComposition.stderr.length },
        minimalEffectiveComposition,
        minimalStructureOk,
      };
    }
  } catch (error) { checks.harnessLauncher = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  let monitorOk = !config.monitor.enabled;
  if (config.monitor.enabled) {
    try {
      if (config.monitor.autoStart) await ensureMonitorRunning(config, defaultConfigPath());
      const status = await pingMonitor(config);
      monitorOk = status.ok;
      checks.monitorStatus = { ...status, dashboardUrl: monitorBaseUrl(config) };
    } catch (error) { checks.monitorStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  const llama = await probeLlamaCpp(config);
  checks.llamaCppProbe = llama;
  const llamaOk = llama.ok === true;
  const ok = node.code === 0 && nodeSupported && git.code === 0 && launcherOk && probeOk && monitorOk && llamaOk &&
    rootChecks.every((item) => item.ok === true) && (!config.enforceHarnessPin || revision.matches);
  return { ok, checks };
}

export interface StartTaskInput { planId: string; leafId: string; taskId?: string }

export async function startTask(input: StartTaskInput): Promise<unknown> {
  const config = await loadConfig();
  return await withMutationLock(config, async () => {
    const plan = await loadPlan(config, safeTaskId(input.planId));
    if (plan.status === "accepted" || plan.status === "rejected") throw new Error(`cannot launch a leaf from finalized plan ${plan.status}`);
    const leafId = safeTaskId(input.leafId);
    const leaf = plan.leaves.find((candidate) => candidate.id === leafId);
    if (!leaf) throw new Error(`leaf not found in plan: ${leafId}`);
    if (leaf.status !== "planned") throw new Error(`leaf ${leafId} cannot launch from status ${leaf.status}`);
    for (const dependencyId of leaf.dependsOn) {
      const dependency = plan.leaves.find((candidate) => candidate.id === dependencyId);
      if (!dependency || (dependency.status !== "verified" && dependency.status !== "accepted")) {
        throw new Error(`leaf ${leafId} is blocked by dependency ${dependencyId}; dependency must be verified before launch`);
      }
    }
    const runtimeLlama = await effectiveLlamaConfig(config);
    if (leaf.executor === "harness" || (leaf.executor === "llama_cpp" && runtimeLlama.fallbackEnabled)) await assertHarnessProvenance(config);
    if (leaf.executor === "llama_cpp" && !runtimeLlama.enabled && !runtimeLlama.fallbackEnabled) {
      throw new Error("llama.cpp was disabled after plan creation and Harness fallback is also disabled");
    }
    const requestedRoot = await ensureAllowedRepo(config, plan.repoRoot);
    const repoRoot = await ensureAllowedRepo(config, await gitTopLevel(requestedRoot));
    if (await resolveCommit(repoRoot, plan.baseCommit) !== plan.baseCommit) throw new Error("controller base commit no longer resolves");
    if (config.requireCleanRepoAtStart) {
      const dirtyPaths = await workingTreePaths(repoRoot);
      if (dirtyPaths.length) throw new Error(`repository must remain clean until the worker leaf is launched: ${dirtyPaths.slice(0, 20).join(", ")}`);
    }
    const activeTasks = (await listTasks(config)).filter((candidate) => candidate.status === "queued" || candidate.status === "running");
    const activeHarness = activeTasks.filter((candidate) => (candidate.effectiveExecutor ?? candidate.executor) === "harness");
    if (leaf.executor === "harness" && activeHarness.length >= config.controller.maxConcurrentHarnessGlobal) {
      throw new Error(`global Harness concurrency limit reached: ${activeHarness.length} >= ${config.controller.maxConcurrentHarnessGlobal}`);
    }
    const activeInRepo = activeTasks.filter((candidate) => path.resolve(candidate.repoRoot) === path.resolve(repoRoot));
    const activeHarnessInRepo = activeInRepo.filter((candidate) => (candidate.effectiveExecutor ?? candidate.executor) === "harness");
    if (leaf.executor === "harness" && activeHarnessInRepo.length >= config.controller.maxConcurrentHarnessPerRepo) {
      throw new Error(`repository Harness concurrency limit reached: ${activeHarnessInRepo.length} >= ${config.controller.maxConcurrentHarnessPerRepo}`);
    }
    for (const existing of activeInRepo) {
      try { assertDisjointLeases(existing.harnessWritePaths, leaf.harnessWritePaths); }
      catch { throw new Error(`leaf ${leafId} write leases overlap active task ${existing.id}`); }
    }
    const id = safeTaskId(input.taskId ?? `${plan.id}-${leaf.id}`);
    if (await pathExists(taskFile(config, id))) throw new Error(`task already exists: ${id}`);
    const symlinkIntersections = findLeaseSymlinkIntersections(await symlinkPathsAtCommit(repoRoot, plan.baseCommit), leaf.harnessWritePaths);
    if (symlinkIntersections.length) throw new Error(`worker leases intersect tracked symlinks: ${symlinkIntersections.join(", ")}`);
    const gitlinkIntersections = findLeaseSymlinkIntersections(await gitlinkPathsAtCommit(repoRoot, plan.baseCommit), leaf.harnessWritePaths);
    if (gitlinkIntersections.length) throw new Error(`worker leases intersect tracked gitlinks/submodules: ${gitlinkIntersections.join(", ")}`);
    const environmentFiles = await environmentFilesAtCommit(repoRoot, plan.baseCommit);
    if (environmentFiles.length > 0) {
      throw new Error(`tracked environment files are forbidden for Harness tasks: ${environmentFiles.slice(0, 20).join(", ")}`);
    }
    if (leaf.executor === "harness" || runtimeLlama.fallbackEnabled) await readProviderApiKey(config);
    if (config.monitor.enabled) await ensureMonitorRunning(config, defaultConfigPath());
    const worktreePath = path.join(config.stateRoot, "worktrees", path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-"), id);
    const branchName = `agent/${leaf.executor === "harness" ? "harness" : "llama"}/${id}`;
    await ensureDir(path.dirname(worktreePath));
    let worktreeCreated = false;
    let task: TaskRecord | undefined;
    try {
      await createWorktree(repoRoot, worktreePath, branchName, plan.baseCommit);
      worktreeCreated = true;
      const dir = taskDirectory(config, id);
      await ensureDir(dir);
      const proxyToken = config.monitor.enabled && (leaf.executor === "harness" || runtimeLlama.fallbackEnabled) ? randomBytes(24).toString("hex") : undefined;
      task = {
        schemaVersion: 6,
        id,
        planId: plan.id,
        leafId: leaf.id,
        budgetGroupId: id,
        requestedExecutor: leaf.requestedExecutor,
        executor: leaf.executor,
        effectiveExecutor: leaf.executor,
        routingReason: leaf.routingReason,
        complexity: leaf.complexity,
        harnessMode: leaf.harnessMode,
        ...(leaf.parallelGroup ? { parallelGroup: leaf.parallelGroup } : {}),
        dependsOn: leaf.dependsOn,
        toolCapabilities: leaf.toolCapabilities,
        taskFamily: leaf.taskFamily,
        splitDecision: leaf.splitDecision,
        mode: leaf.mode,
        objective: leaf.objective,
        repoRoot,
        baseRef: plan.baseRef,
        baseCommit: plan.baseCommit,
        startingHeadCommit: plan.baseCommit,
        branchName,
        worktreePath,
        harnessWritePaths: leaf.harnessWritePaths,
        codexWritePaths: leaf.codexWritePaths,
        acceptanceCriteria: leaf.acceptanceCriteria,
        contextFiles: leaf.contextFiles,
        verificationCommands: leaf.verificationCommands,
        budget: leaf.budget,
        status: "queued",
        createdAt: nowIso(),
        runtimeSeconds: leaf.runtimeSeconds,
        promptPath: path.join(dir, "prompt.md"),
        stdoutPath: path.join(dir, "worker.stdout.log"),
        stderrPath: path.join(dir, "worker.stderr.log"),
        usagePath: path.join(dir, "usage.ndjson"),
        changedPaths: [],
        outOfScopePaths: [],
        ...(leaf.harnessMode === "minimal" ? { minimalRequestPhase: "booting" as const } : {}),
        ...(leaf.model ? { model: leaf.model } : {}),
        ...(proxyToken ? {
          proxyToken,
          dashboardUrl: `${monitorBaseUrl(config)}/#task=${encodeURIComponent(id)}`,
          upstreamBaseUrl: validatedHarnessUpstreamBaseUrl(config),
        } : {}),
      };
      await writeFile(task.promptPath, checkedHarnessPrompt(task), { mode: 0o600 });
      await createTask(config, task);
      await updatePlan(config, plan.id, (current) => {
        const selected = current.leaves.find((candidate) => candidate.id === leaf.id);
        if (!selected || selected.status !== "planned") throw new Error("controller leaf changed during launch");
        selected.status = "running";
        selected.activeTaskId = id;
        current.status = "running";
      });
      const workerPid = await spawnWorker(config, task);
      return {
        taskId: task.id, planId: plan.id, leafId: leaf.id, executor: task.executor,
        status: task.status, workerPid, baseCommit: task.baseCommit, branchName, worktreePath,
        harnessWritePaths: task.harnessWritePaths, codexWritePaths: task.codexWritePaths,
        budget: task.budget, dashboardUrl: task.dashboardUrl, harnessMode: task.harnessMode,
        nextAction: "Codex should immediately execute its disjoint lane. When the worker stops, collect every changed file, record a review decision, then run authoritative verification.",
      };
    } catch (error) {
      if (task && await pathExists(taskFile(config, task.id))) {
        task = await updateTask(config, task.id, (current) => {
          if (current.status !== "cancelled") { current.status = "failed"; current.completedAt = nowIso(); current.error = `launch failed: ${error instanceof Error ? error.message : String(error)}`; }
        });
        if (worktreeCreated) {
          try { await removeWorktree(repoRoot, worktreePath, true); task.worktreeRemoved = true; } catch { /* preserve */ }
          try { await deleteBranch(repoRoot, branchName, true); task.branchDeleted = true; } catch { /* preserve */ }
        }
        await saveTask(config, task);
      } else if (worktreeCreated) {
        try { await removeWorktree(repoRoot, worktreePath, true); } catch { /* preserve */ }
        try { await deleteBranch(repoRoot, branchName, true); } catch { /* preserve */ }
      }
      throw error;
    }
  });
}

export async function taskStatus(taskId: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  let task = await loadTask(config, id);
  const taskActive = task.status === "queued" || task.status === "running";
  const workerAlive = await processIdentityMatches(task.workerIdentity);
  const livenessDecision = decideWorkerLiveness(
    taskActive,
    workerAlive,
    task.workerDeadObservedAt,
    Date.now(),
    WORKER_ORPHAN_GRACE_MS,
  );
  if (livenessDecision === "observe-dead" || livenessDecision === "clear-dead-observation" || livenessDecision === "orphan") {
    task = await updateTask(config, id, (current) => {
      const currentActive = current.status === "queued" || current.status === "running";
      const sameLifetime = current.workerIdentity?.startTimeTicks === task.workerIdentity?.startTimeTicks;
      if (!sameLifetime) return;
      const currentAlive = workerAlive;
      const currentDecision = decideWorkerLiveness(
        currentActive,
        currentAlive,
        current.workerDeadObservedAt,
        Date.now(),
        WORKER_ORPHAN_GRACE_MS,
      );
      if (currentDecision === "observe-dead") {
        current.workerDeadObservedAt = nowIso();
      } else if (currentDecision === "clear-dead-observation") {
        delete current.workerDeadObservedAt;
      } else if (currentDecision === "orphan") {
        current.status = "orphaned";
        current.completedAt ??= nowIso();
        current.error ??= "worker process remained dead after the terminal-publication grace interval";
      }
    });
  }
  const usage = await usageForBudgetGroup(config, task.budgetGroupId);
  const budget = await effectiveBudget(config, task.budget, task.budgetGroupId);
  const referenceAlerts = budgetReferenceAlerts(usage, budget);
  if (terminal(task) && !task.splitOutcomeRecordedAt) {
    try {
      const profile = await recordTaskSplitOutcome(config, task, "execution");
      if (profile) {
        task = await updateTask(config, task.id, (current) => {
          current.splitOutcomeRecordedAt = nowIso();
          current.splitOutcomeRevision = profile.revision;
          current.referenceAlerts = referenceAlerts;
        });
      }
    } catch { /* status remains readable even if memory maintenance fails */ }
  }
  return {
    taskId: task.id,
    planId: task.planId,
    leafId: task.leafId,
    requestedExecutor: task.requestedExecutor ?? task.executor,
    executor: task.executor,
    effectiveExecutor: task.effectiveExecutor ?? task.executor,
    routingReason: task.routingReason,
    fallbackUsed: task.fallbackUsed ?? false,
    fallbackReason: task.fallbackReason,
    fallbackModel: task.fallbackModel,
    complexity: task.complexity,
    harnessMode: task.harnessMode,
    parallelGroup: task.parallelGroup,
    dependsOn: task.dependsOn,
    toolCapabilities: task.toolCapabilities,
    taskFamily: task.taskFamily,
    splitDecision: task.splitDecision,
    executionAttempts: task.executionAttempts ?? [],
    status: task.status,
    phase: task.phase,
    workerAlive: await processIdentityMatches(task.workerIdentity),
    harnessAlive: await processIdentityMatches(task.harnessIdentity),
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    changedPaths: task.changedPaths,
    outOfScopePaths: task.outOfScopePaths,
    unsafeSymlinkPaths: task.unsafeSymlinkPaths ?? [],
    unsafeGitlinkPaths: task.unsafeGitlinkPaths ?? [],
    stagedPaths: task.stagedPaths ?? [],
    exitCode: task.exitCode,
    error: task.error,
    reviewDecision: task.reviewDecision,
    reviewedFingerprint: task.reviewedFingerprint,
    verificationPassed: task.verificationPassed,
    verifiedAt: task.verifiedAt,
    verifiedFingerprint: task.verifiedFingerprint,
    usage,
    budget,
    frozenBudget: task.budget,
    budgetExceededReason: budgetExceededReason(usage, budget),
    referenceAlerts,
    toolProtocolRecoveryCount: task.toolProtocolRecoveryCount ?? 0,
    toolProtocolRecoveryKinds: task.toolProtocolRecoveryKinds ?? [],
    toolProtocolRecoveredTools: task.toolProtocolRecoveredTools ?? [],
    toolProtocolNativeCallCount: task.toolProtocolNativeCallCount ?? 0,
    toolProtocolNativeTools: task.toolProtocolNativeTools ?? [],
    minimalMutationForceCount: task.minimalMutationForceCount ?? 0,
    minimalMutationForcedTools: task.minimalMutationForcedTools ?? [],
    minimalMutationPolicyVersion: task.minimalMutationPolicyVersion,
    minimalMutationLastAt: task.minimalMutationLastAt,
    minimalMutationAuxiliaryBypassCount: task.minimalMutationAuxiliaryBypassCount ?? 0,
    minimalMutationAuxiliaryBypassKinds: task.minimalMutationAuxiliaryBypassKinds ?? [],
    minimalMutationAuxiliaryLastAt: task.minimalMutationAuxiliaryLastAt,
    minimalRequestPhase: task.minimalRequestPhase,
    minimalRunnerPresetId: task.minimalRunnerPresetId,
    minimalRunnerVisibleTools: task.minimalRunnerVisibleTools ?? [],
    minimalAssembledTools: task.minimalAssembledTools ?? [],
    minimalCoreMutationTools: task.minimalCoreMutationTools ?? [],
    minimalRunnerSnapshotAt: task.minimalRunnerSnapshotAt,
    minimalPrimaryMutationArmedAt: task.minimalPrimaryMutationArmedAt,
    minimalRequestOrdinal: task.minimalRequestOrdinal ?? 0,
    minimalRequestEvidence: task.minimalRequestEvidence ?? [],
    providerRequestOrdinal: task.providerRequestOrdinal ?? 0,
    thinkingRequestEvidence: task.thinkingRequestEvidence ?? [],
    reasoningReplayRequirements: task.reasoningReplayRequirements ?? [],
    thinkingPolicyFailureAt: task.thinkingPolicyFailureAt,
    toolProtocolFailure: task.toolProtocolFailure,
    toolProtocolFailureAt: task.toolProtocolFailureAt,
    infrastructureFailureKind: task.infrastructureFailureKind,
    infrastructureFailureDetails: task.infrastructureFailureDetails,
    splitOutcomeRevision: task.splitOutcomeRevision,
    dashboardUrl: task.dashboardUrl,
    worktreeRemoved: task.worktreeRemoved ?? false,
    branchDeleted: task.branchDeleted ?? false,
    stdoutTail: await tailText(task.stdoutPath, Math.min(config.logTailChars, 8000)),
    stderrTail: await tailText(task.stderrPath, Math.min(config.logTailChars, 8000)),
  };
}

export async function collectTask(taskId: string, includePatch: boolean, maxPatchChars: number): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const initial = await loadTask(config, id);
  return await withWorktreeLock(config, initial.worktreePath, async () => {
    const task = await loadTask(config, id);
    if (!terminal(task)) throw new Error("cannot collect a stable patch while task is active; use harness_status");
    await assertWorktreeIdle(config, task.worktreePath);
    await assertTaskWorktreeIdentity(task);
    const paths = await changedPaths(task.worktreePath, task.baseCommit);
    const outOfScope = findOutOfScope(paths, task.harnessWritePaths);
    const unsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, paths);
    const unsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, paths);
    const staged = await stagedPaths(task.worktreePath);
    const patch = await binaryPatch(task.worktreePath, task.baseCommit);
    const currentFingerprint = await changeFingerprint(task);
    const patchPath = path.join(taskDirectory(config, task.id), "changes.patch");
    await writeFile(patchPath, patch, { mode: 0o600 });
    task.changedPaths = paths;
    task.outOfScopePaths = outOfScope;
    task.unsafeSymlinkPaths = unsafeSymlinks;
    task.unsafeGitlinkPaths = unsafeGitlinks;
    task.stagedPaths = staged;
    await saveTask(config, task);
    const capped = Math.max(0, Math.min(maxPatchChars, 100_000));
    const response: Record<string, unknown> = {
      taskId: task.id,
      status: task.status,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      baseCommit: task.baseCommit,
      changedPaths: paths,
      outOfScopePaths: outOfScope,
      unsafeSymlinkPaths: unsafeSymlinks,
      unsafeGitlinkPaths: unsafeGitlinks,
      stagedPaths: staged,
      diffStat: await diffStat(task.worktreePath, task.baseCommit),
      commitLog: await commitLog(task.worktreePath, task.baseCommit),
      fullPatchPath: patchPath,
      resultSummary: task.resultSummary ?? await tailText(task.stdoutPath, config.logTailChars),
      stderrTail: await tailText(task.stderrPath, config.logTailChars),
      reviewDecision: task.reviewDecision,
      reviewedFingerprint: task.reviewedFingerprint,
      verificationPassed: task.verificationPassed,
      verifiedFingerprint: task.verifiedFingerprint,
      currentFingerprint,
      usage: await usageForBudgetGroup(config, task.budgetGroupId),
      budget: await effectiveBudget(config, task.budget, task.budgetGroupId),
      frozenBudget: task.budget,
      dashboardUrl: task.dashboardUrl,
    };
    if (includePatch) {
      response.patch = patch.length <= capped ? patch : `${patch.slice(0, capped)}\n\n[PATCH TRUNCATED: ${patch.length - capped} characters omitted]`;
    }
    return response;
  });
}

export async function readChangedFile(taskId: string, filePath: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const initial = await loadTask(config, id);
  return await withWorktreeLock(config, initial.worktreePath, async () => {
    const task = await loadTask(config, id);
    if (!terminal(task)) throw new Error("cannot read a stable changed file while task is active");
    await assertWorktreeIdle(config, task.worktreePath);
    await assertTaskWorktreeIdentity(task);
    const normalized = normalizeRepoRelative(filePath);
    const paths = await changedPaths(task.worktreePath, task.baseCommit);
    if (!paths.includes(normalized)) throw new Error("requested path is not part of the task change set");
    return { taskId: task.id, filePath: normalized, content: await readRepoFile(task.worktreePath, normalized) };
  });
}

export async function reviewTask(taskId: string, decision: ReviewDecision, reviewedPaths: string[], notes: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const initial = await loadTask(config, id);
  return await withWorktreeLock(config, initial.worktreePath, async () => {
    const task = await loadTask(config, id);
    assertAdoptableStatus(task, "review");
    await assertWorktreeIdle(config, task.worktreePath);
    await assertTaskWorktreeIdentity(task);
    await assertTaskHeadExpected(task, "review");
    const paths = await changedPaths(task.worktreePath, task.baseCommit);
    const supplied = [...new Set(reviewedPaths.map(normalizeRepoRelative))].sort();
    const expected = [...paths].sort();
    if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
      throw new Error(`Codex review must acknowledge every changed path exactly once; expected ${expected.join(", ") || "(none)"}`);
    }
    const outOfScope = findOutOfScope(paths, task.harnessWritePaths);
    const unsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, paths);
    const unsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, paths);
    const staged = await stagedPaths(task.worktreePath);
    if (decision !== "rejected" && (outOfScope.length || unsafeSymlinks.length || unsafeGitlinks.length || staged.length)) {
      throw new Error("unsafe or out-of-scope changes cannot receive approved/revise review; reject the task");
    }
    const boundedNotes = boundedText(notes || (decision === "approved" ? "Codex reviewed all changed files." : "No review notes supplied."), "review notes", 32_000);
    const fingerprint = await changeFingerprint(task);
    task.changedPaths = paths;
    task.outOfScopePaths = outOfScope;
    task.unsafeSymlinkPaths = unsafeSymlinks;
    task.unsafeGitlinkPaths = unsafeGitlinks;
    task.stagedPaths = staged;
    task.reviewDecision = decision;
    task.reviewNotes = boundedNotes;
    task.reviewedPaths = supplied;
    task.reviewedAt = nowIso();
    task.reviewedFingerprint = fingerprint;
    delete task.verificationPassed;
    delete task.verifiedAt;
    delete task.verifiedCommands;
    delete task.verifiedFingerprint;
    await saveTask(config, task);
    await updatePlan(config, task.planId, (plan) => {
      const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
      if (!leaf) throw new Error(`plan leaf missing during review: ${task.leafId}`);
      leaf.activeTaskId = task.id;
      leaf.completedTaskId = task.id;
      leaf.reviewDecision = decision;
      leaf.reviewedFingerprint = fingerprint;
      delete leaf.verifiedFingerprint;
      delete leaf.bridgeCommit;
      if (decision === "approved") leaf.status = "reviewed";
      else if (decision === "revise") leaf.status = "completed";
      else {
        leaf.status = "rejected";
        plan.status = "running";
      }
    });
    try { await recordTaskSplitOutcome(config, task, "review"); } catch { /* review result remains authoritative */ }
    return { taskId: task.id, planId: task.planId, leafId: task.leafId, decision, reviewedPaths: supplied, reviewedFingerprint: fingerprint, notes: boundedNotes };
  });
}

export async function repairTask(parentTaskId: string, feedback: string, runtimeSeconds?: number): Promise<unknown> {
  const config = await loadConfig();
  return await withMutationLock(config, async () => {
    const parentId = safeTaskId(parentTaskId);
    const initial = await loadTask(config, parentId);
    const runtimeLlama = await effectiveLlamaConfig(config);
    if (initial.executor === "harness" || (initial.executor === "llama_cpp" && runtimeLlama.fallbackEnabled)) await assertHarnessProvenance(config);
    if (initial.executor === "harness" || runtimeLlama.fallbackEnabled) {
      await readProviderApiKey(config);
      if (!config.monitor.enabled) throw new Error("Harness repair requires the credential-brokering monitor proxy");
      await ensureMonitorRunning(config, defaultConfigPath());
    }
    return await withWorktreeLock(config, initial.worktreePath, async () => {
      const parent = await loadTask(config, parentId);
      if (!terminal(parent)) throw new Error("cannot repair while parent task is active");
      if (parent.reviewDecision !== "revise") throw new Error("repair requires a Codex review decision of revise");
      if (parent.worktreeRemoved) throw new Error("cannot repair a task whose worktree was removed");
      const totals = await usageForBudgetGroup(config, parent.budgetGroupId);
      const repairBudget = await effectiveBudget(config, parent.budget, parent.budgetGroupId);
      const exhausted = budgetExceededReason(totals, repairBudget);
      if (exhausted) throw new Error(`cannot launch repair because the cumulative leaf budget is exhausted: ${exhausted}`);
      await assertTaskWorktreeIdentity(parent);
      await assertWorktreeIdle(config, parent.worktreePath);
      await assertTaskHeadExpected(parent, "repair");
      const startingHeadCommit = await resolveCommit(parent.worktreePath, "HEAD");
      const family = (await listTasks(config)).filter((task) => task.budgetGroupId === parent.budgetGroupId);
      const id = safeTaskId(`${parent.budgetGroupId}-r${family.length}`);
      if (await pathExists(taskFile(config, id))) throw new Error(`repair task already exists: ${id}`);
      const dir = taskDirectory(config, id);
      await ensureDir(dir);
      const task: TaskRecord = {
        ...parent,
        id,
        parentTaskId: parent.id,
        mode: "repair",
        phase: `repair-${family.length}`,
        startingHeadCommit,
        objective: boundedText(`Repair ${parent.leafId}: ${parent.objective}`, "repair objective", config.controller.maxHarnessObjectiveChars),
        status: "queued",
        createdAt: nowIso(),
        runtimeSeconds: validateRuntime(config, runtimeSeconds ?? parent.runtimeSeconds),
        promptPath: path.join(dir, "prompt.md"),
        stdoutPath: path.join(dir, "worker.stdout.log"),
        stderrPath: path.join(dir, "worker.stderr.log"),
        usagePath: path.join(dir, "usage.ndjson"),
        changedPaths: [],
        outOfScopePaths: [],
        worktreeRemoved: false,
        branchDeleted: false,
        ...(config.monitor.enabled && (parent.executor === "harness" || runtimeLlama.fallbackEnabled) ? {
          proxyToken: randomBytes(24).toString("hex"),
          dashboardUrl: `${monitorBaseUrl(config)}/#task=${encodeURIComponent(id)}`,
          upstreamBaseUrl: parent.upstreamBaseUrl ?? validatedHarnessUpstreamBaseUrl(config),
        } : {}),
      };
      delete task.startedAt;
      delete task.completedAt;
      delete task.cleanedAt;
      delete task.workerPid;
      delete task.workerIdentity;
      delete task.workerDeadObservedAt;
      delete task.harnessPid;
      delete task.harnessIdentity;
      delete task.exitCode;
      delete task.resultSummary;
      delete task.error;
      delete task.fallbackUsed;
      delete task.fallbackReason;
      delete task.fallbackModel;
      delete task.executionAttempts;
      task.effectiveExecutor = task.executor;
      delete task.reviewDecision;
      delete task.reviewNotes;
      delete task.reviewedPaths;
      delete task.reviewedAt;
      delete task.reviewedFingerprint;
      delete task.verificationPassed;
      delete task.verifiedAt;
      delete task.verifiedCommands;
      delete task.verifiedFingerprint;
      delete task.bridgeCommit;
      delete task.bridgeCommittedAt;
      delete task.splitOutcomeRecordedAt;
      delete task.splitOutcomeRevision;
      delete task.referenceAlerts;
      delete task.toolProtocolFailure;
      delete task.toolProtocolFailureAt;
      delete task.toolProtocolRecoveryCount;
      delete task.toolProtocolRecoveryKinds;
      delete task.toolProtocolRecoveredTools;
      delete task.toolProtocolNativeCallCount;
      delete task.toolProtocolNativeTools;
      delete task.infrastructureFailureKind;
      delete task.infrastructureFailureDetails;
      delete task.minimalMutationForceCount;
      delete task.minimalMutationForcedTools;
      delete task.minimalMutationPolicyVersion;
      delete task.minimalMutationLastAt;
      delete task.minimalMutationAuxiliaryBypassCount;
      delete task.minimalMutationAuxiliaryBypassKinds;
      delete task.minimalMutationAuxiliaryLastAt;
      delete task.minimalRunnerPresetId;
      delete task.minimalRunnerVisibleTools;
      delete task.minimalAssembledTools;
      delete task.minimalCoreMutationTools;
      delete task.minimalRunnerSnapshotAt;
      delete task.minimalPrimaryMutationArmedAt;
      delete task.minimalRequestOrdinal;
      delete task.minimalRequestEvidence;
      delete task.providerRequestOrdinal;
      delete task.thinkingRequestEvidence;
      delete task.reasoningReplayRequirements;
      delete task.thinkingPolicyFailureAt;
      if (task.harnessMode === "minimal") task.minimalRequestPhase = "booting";
      else delete task.minimalRequestPhase;
      const boundedFeedback = boundedText(feedback, "feedback", 32_000);
      await writeFile(task.promptPath, checkedHarnessPrompt(task, boundedFeedback), { mode: 0o600 });
      await createTask(config, task);
      await updatePlan(config, task.planId, (plan) => {
        const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
        if (!leaf) throw new Error(`plan leaf missing during repair: ${task.leafId}`);
        leaf.status = "running";
        leaf.activeTaskId = task.id;
        delete leaf.reviewDecision;
        delete leaf.reviewedFingerprint;
        delete leaf.verifiedFingerprint;
      });
      try {
        const workerPid = await spawnWorker(config, task);
        return { taskId: task.id, parentTaskId: parent.id, planId: task.planId, leafId: task.leafId, executor: task.executor, status: task.status, workerPid, worktreePath: task.worktreePath, cumulativeUsage: totals, budget: repairBudget, frozenBudget: task.budget };
      } catch (error) {
        await updateTask(config, task.id, (current) => {
          if (current.status !== "cancelled") { current.status = "failed"; current.completedAt = nowIso(); current.error = `repair launch failed: ${error instanceof Error ? error.message : String(error)}`; }
        });
        throw error;
      }
    });
  });
}

export async function verifyTask(taskId: string, commands?: string[], timeoutSeconds = 1800): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const initial = await loadTask(config, id);
  return await withWorktreeLock(config, initial.worktreePath, async () => {
    const task = await loadTask(config, id);
    assertAdoptableStatus(task, "verification");
    if (task.reviewDecision !== "approved" || !task.reviewedFingerprint) {
      throw new Error("verification requires an approved Codex review with a recorded diff fingerprint");
    }
    const reviewedFingerprint = task.reviewedFingerprint;
    await assertWorktreeIdle(config, task.worktreePath);
    await assertTaskWorktreeIdentity(task);
    await assertTaskHeadExpected(task, "verification");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) throw new Error("timeoutSeconds must be an integer from 1 to 7200");
    const stored = boundedStringList(task.verificationCommands, "stored verification commands", 100, 16_000);
    const selected = boundedStringList(commands?.length ? commands : stored, "verification commands", 100, 16_000);
    if (!selected.length) throw new Error("controller plan contains no verification commands");
    if (commands?.length && JSON.stringify(selected) !== JSON.stringify(stored)) {
      throw new Error("verification commands are frozen by the controller plan; create a new plan to change them");
    }
    const beforePaths = await changedPaths(task.worktreePath, task.baseCommit);
    const beforeViolations = findOutOfScope(beforePaths, task.harnessWritePaths);
    if (beforeViolations.length) throw new Error(`cannot verify out-of-scope changes: ${beforeViolations.join(", ")}`);
    const beforeUnsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, beforePaths);
    if (beforeUnsafeSymlinks.length) throw new Error(`cannot verify changed symlink paths: ${beforeUnsafeSymlinks.join(", ")}`);
    const beforeUnsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, beforePaths);
    if (beforeUnsafeGitlinks.length) throw new Error(`cannot verify changed gitlink/submodule metadata: ${beforeUnsafeGitlinks.join(", ")}`);
    const beforeStaged = await stagedPaths(task.worktreePath);
    if (beforeStaged.length) throw new Error(`cannot verify worker-staged index changes: ${beforeStaged.join(", ")}`);
    const beforeFingerprint = await changeFingerprint(task);
    if (beforeFingerprint !== reviewedFingerprint) {
      throw new Error("task diff changed after Codex review; collect and review every changed file again before verification");
    }
    const results: Array<Record<string, unknown>> = [];
    for (const command of selected) {
      const result = await runProcess("bash", ["--noprofile", "--norc", "-lc", command], {
        cwd: task.worktreePath,
        env: sanitizedEnvironment(config),
        timeoutMs: timeoutSeconds * 1_000,
        maxCaptureChars: 200_000,
        killProcessGroup: true,
      });
      results.push({ command, ...result });
      if (result.code !== 0) break;
    }
    await assertTaskWorktreeIdentity(task);
    await assertTaskHeadExpected(task, "verification");
    const finalPaths = await changedPaths(task.worktreePath, task.baseCommit);
    const finalViolations = findOutOfScope(finalPaths, task.harnessWritePaths);
    const finalUnsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, finalPaths);
    const finalUnsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, finalPaths);
    const finalStaged = await stagedPaths(task.worktreePath);
    const finalFingerprint = await changeFingerprint(task);
    const fingerprintStable = finalFingerprint === reviewedFingerprint;
    const passed = results.length === selected.length && results.every((item) => item.code === 0) && finalViolations.length === 0 && finalUnsafeSymlinks.length === 0 && finalUnsafeGitlinks.length === 0 && finalStaged.length === 0 && fingerprintStable;
    task.verificationPassed = passed;
    task.verifiedAt = nowIso();
    task.verifiedCommands = selected;
    task.verifiedFingerprint = finalFingerprint;
    task.changedPaths = finalPaths;
    task.outOfScopePaths = finalViolations;
    task.unsafeSymlinkPaths = finalUnsafeSymlinks;
    task.unsafeGitlinkPaths = finalUnsafeGitlinks;
    task.stagedPaths = finalStaged;
    if (!fingerprintStable) task.error = "authoritative verification modified the reviewed diff; restore or re-review before adoption";
    await saveTask(config, task);
    await updatePlan(config, task.planId, (plan) => {
      const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
      if (!leaf) throw new Error(`plan leaf missing during verification: ${task.leafId}`);
      leaf.completedTaskId = task.id;
      if (passed) {
        leaf.status = "verified";
        leaf.reviewDecision = "approved";
        leaf.reviewedFingerprint = reviewedFingerprint;
        leaf.verifiedFingerprint = finalFingerprint;
      } else {
        leaf.status = "reviewed";
        delete leaf.verifiedFingerprint;
      }
    });
    try { await recordTaskSplitOutcome(config, task, "verification"); } catch { /* verification result remains authoritative */ }
    return {
      taskId: task.id, planId: task.planId, leafId: task.leafId, passed,
      reviewedFingerprint, verifiedFingerprint: finalFingerprint,
      fingerprintStable, outOfScopePaths: finalViolations, unsafeSymlinkPaths: finalUnsafeSymlinks,
      unsafeGitlinkPaths: finalUnsafeGitlinks, stagedPaths: finalStaged, results,
    };
  });
}

export async function commitTask(taskId: string, message?: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const initial = await loadTask(config, id);
  return await withWorktreeLock(config, initial.worktreePath, async () => {
    const task = await loadTask(config, id);
    assertAdoptableStatus(task, "commit");
    if (task.reviewDecision !== "approved" || !task.reviewedFingerprint) throw new Error("commit requires approved Codex review");
    if (!task.verificationPassed || !task.verifiedFingerprint) throw new Error("commit requires passing authoritative verification");
    if (task.reviewedFingerprint !== task.verifiedFingerprint) throw new Error("reviewed and verified fingerprints differ; adoption is forbidden");
    await assertWorktreeIdle(config, task.worktreePath);
    await assertTaskWorktreeIdentity(task);
    const currentHead = await resolveCommit(task.worktreePath, "HEAD");
    if (task.bridgeCommit) {
      const bridgeCommit = task.bridgeCommit;
      if (currentHead !== bridgeCommit) throw new Error(`recorded bridge commit ${bridgeCommit} does not match current HEAD ${currentHead}`);
      const dirtyPaths = await workingTreePaths(task.worktreePath);
      if (dirtyPaths.length) throw new Error(`recorded bridge commit has uncommitted worktree changes: ${dirtyPaths.join(", ")}`);
      const currentFingerprint = await changeFingerprint(task);
      if (currentFingerprint !== task.verifiedFingerprint) throw new Error("recorded bridge commit differs from the reviewed and verified snapshot");
      await updatePlan(config, task.planId, (plan) => {
        const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
        if (leaf) { leaf.status = "accepted"; leaf.bridgeCommit = bridgeCommit; leaf.completedTaskId = task.id; }
      });
      return { taskId: task.id, branchName: task.branchName, commit: bridgeCommit, created: false, cherryPick: bridgeCommit === task.baseCommit ? null : `git cherry-pick ${bridgeCommit}`, alreadyCommitted: true };
    }
    await assertTaskHeadExpected(task, "commit");
    const staged = await stagedPaths(task.worktreePath);
    if (staged.length) throw new Error(`refusing to commit worker-staged index changes: ${staged.join(", ")}`);
    const paths = await changedPaths(task.worktreePath, task.baseCommit);
    const violations = findOutOfScope(paths, task.harnessWritePaths);
    if (violations.length) throw new Error(`refusing to commit out-of-scope paths: ${violations.join(", ")}`);
    const unsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, paths);
    if (unsafeSymlinks.length) throw new Error(`refusing to commit changed symlink paths: ${unsafeSymlinks.join(", ")}`);
    const unsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, paths);
    if (unsafeGitlinks.length) throw new Error(`refusing to commit changed gitlink/submodule metadata: ${unsafeGitlinks.join(", ")}`);
    const currentFingerprint = await changeFingerprint(task);
    if (currentFingerprint !== task.reviewedFingerprint || currentFingerprint !== task.verifiedFingerprint) {
      throw new Error("task changes differ from the reviewed and verified snapshot; re-collect, review, and verify");
    }
    const commitMessage = boundedText(message ?? `feat(${task.executor}): ${task.objective.slice(0, 72)}`, "commit message", 4_000);
    const committed = await createCommit(task.worktreePath, commitMessage);
    await updateTask(config, task.id, (current) => {
      current.bridgeCommit = committed.commit;
      current.bridgeCommittedAt = nowIso();
    });
    await updatePlan(config, task.planId, (plan) => {
      const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
      if (!leaf) throw new Error(`plan leaf missing during commit: ${task.leafId}`);
      leaf.status = "accepted";
      leaf.bridgeCommit = committed.commit;
      leaf.completedTaskId = task.id;
    });
    return {
      taskId: task.id, planId: task.planId, leafId: task.leafId, branchName: task.branchName,
      commit: committed.commit, created: committed.created,
      cherryPick: committed.created ? `git cherry-pick ${committed.commit}` : null,
      reviewedFingerprint: task.reviewedFingerprint, currentFingerprint, verifiedFingerprint: task.verifiedFingerprint,
      alreadyCommitted: false,
    };
  });
}

export async function cancelTask(taskId: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(taskId);
  const current = await loadTask(config, id);
  if (current.status !== "queued" && current.status !== "running") {
    return { taskId: current.id, status: current.status, changed: false };
  }
  const task = await updateTask(config, id, (latest) => {
    if (latest.status === "queued" || latest.status === "running") {
      latest.status = "cancelled";
      latest.completedAt = nowIso();
      latest.error = "cancelled by Codex";
    }
  });
  if (task.status !== "cancelled") return { taskId: task.id, status: task.status, changed: false };
  await Promise.all([
    terminateRecordedProcess(task.harnessIdentity),
    terminateRecordedProcess(task.workerIdentity),
  ]);
  await updatePlan(config, task.planId, (plan) => {
    const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
    if (leaf) {
      leaf.status = "rejected";
      leaf.activeTaskId = task.id;
      leaf.completedTaskId = task.id;
    }
    plan.status = "rejected";
  });
  return { taskId: task.id, planId: task.planId, leafId: task.leafId, status: task.status, changed: true };
}

export async function cleanupTask(taskId: string, force: boolean, deleteTaskBranch: boolean): Promise<unknown> {
  const config = await loadConfig();
  return await withMutationLock(config, async () => {
    const id = safeTaskId(taskId);
    const initial = await loadTask(config, id);
    return await withWorktreeLock(config, initial.worktreePath, async () => {
      const task = await loadTask(config, id);
      if (!terminal(task)) throw new Error("cannot clean up an active task");
      if (task.status === "cancelled" && (
        await processIdentityMatches(task.workerIdentity) || await processIdentityMatches(task.harnessIdentity)
      )) {
        throw new Error("cancelled task processes are still stopping; poll harness_status before cleanup");
      }
      await assertWorktreeIdle(config, task.worktreePath);
      const related = (await listTasks(config)).filter((candidate) => candidate.worktreePath === task.worktreePath);
      const persistFlags = async (cleanedAt?: string): Promise<void> => {
        for (const candidate of related) {
          if (cleanedAt) candidate.cleanedAt = cleanedAt;
          if (task.worktreeRemoved) candidate.worktreeRemoved = true;
          if (task.branchDeleted) candidate.branchDeleted = true;
          await saveTask(config, candidate);
        }
      };

      if (!task.worktreeRemoved) {
        if (await pathExists(task.worktreePath)) {
          await removeWorktree(task.repoRoot, task.worktreePath, force);
        }
        task.worktreeRemoved = !await pathExists(task.worktreePath);
        if (!task.worktreeRemoved) throw new Error(`worktree still exists after cleanup attempt: ${task.worktreePath}`);
        // Persist the irreversible worktree removal before attempting optional branch deletion.
        // A protected/unmerged branch may make `git branch -d` fail, but state must remain truthful.
        await persistFlags();
      }
      if (deleteTaskBranch && !task.branchDeleted) {
        await deleteBranch(task.repoRoot, task.branchName, force);
        task.branchDeleted = true;
        await persistFlags();
      }
      const cleanedAt = nowIso();
      await persistFlags(cleanedAt);
      return {
        taskId: task.id,
        relatedTaskIds: related.map((candidate) => candidate.id),
        worktreeRemoved: task.worktreeRemoved ?? false,
        branchDeleted: task.branchDeleted ?? false,
        logsRetainedAt: taskDirectory(config, task.id),
      };
    });
  });
}

export async function listRecentTasks(limit: number): Promise<unknown> {
  const config = await loadConfig();
  const tasks = (await listTasks(config)).slice(0, Math.max(1, Math.min(limit, 50)));
  const summaries = [];
  for (const task of tasks) {
    summaries.push({
      ...publicTaskSummary(task),
      usage: await usageForBudgetGroup(config, task.budgetGroupId),
      budget: await effectiveBudget(config, task.budget, task.budgetGroupId),
      frozenBudget: task.budget,
    });
  }
  return summaries;
}

export async function finalizeControllerPlan(planId: string, integrationEvidence: string): Promise<unknown> {
  const config = await loadConfig();
  const id = safeTaskId(planId);
  const evidence = boundedText(integrationEvidence, "integration evidence", 32_000);
  return await withMutationLock(config, async () => {
    const plan = await loadPlan(config, id);
    if (plan.status === "rejected") throw new Error("a rejected controller plan cannot be finalized as accepted");
    const incomplete = plan.leaves.filter((leaf) => leaf.status !== "accepted" || leaf.reviewDecision !== "approved" || !leaf.reviewedFingerprint || !leaf.verifiedFingerprint || leaf.reviewedFingerprint !== leaf.verifiedFingerprint);
    if (incomplete.length) throw new Error(`all leaves must be reviewed, verified, and accepted before finalization: ${incomplete.map((leaf) => `${leaf.id}:${leaf.status}`).join(", ")}`);
    const tasks = await listTasks(config);
    for (const leaf of plan.leaves) {
      const task = tasks.find((candidate) => candidate.id === leaf.completedTaskId);
      if (!task || !task.verificationPassed || task.reviewDecision !== "approved" || task.reviewedFingerprint !== task.verifiedFingerprint) {
        throw new Error(`leaf ${leaf.id} lacks a matching reviewed and verified task record`);
      }
    }
    plan.status = "accepted";
    plan.integrationEvidence = evidence;
    plan.finalizedAt = nowIso();
    plan.updatedAt = plan.finalizedAt;
    await savePlan(config, plan);
    return { planId: plan.id, status: plan.status, finalizedAt: plan.finalizedAt, planHash: plan.planHash, integrationEvidence: evidence, leaves: plan.leaves.map((leaf) => ({ id: leaf.id, commit: leaf.bridgeCommit, verifiedFingerprint: leaf.verifiedFingerprint })) };
  });
}

export async function monitorStatus(): Promise<unknown> {
  const config = await loadConfig();
  return { ...(await pingMonitor(config)), enabled: config.monitor.enabled, dashboardUrl: monitorBaseUrl(config) };
}

export async function monitorSnapshot(limit: number): Promise<unknown> {
  const config = await loadConfig();
  const bounded = Math.max(1, Math.min(limit, 500));
  if (config.monitor.enabled) {
    await ensureMonitorRunning(config, defaultConfigPath());
    try {
      const token = await ensureOperatorToken(config);
      const response = await fetch(`${monitorBaseUrl(config)}/api/snapshot?limit=${bounded}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return await response.json();
    } catch { /* fall back to durable ledger snapshot */ }
  }
  return await buildMonitorSnapshot(config, bounded);
}

export async function monitorStop(): Promise<unknown> {
  const config = await loadConfig();
  return await stopMonitor(config);
}

export { jsonToolResult };
