import { closeSync, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig, ProcessIdentity, TaskBudget, TaskRecord, UsageTotals } from "./types.js";
import { listPlans, listTasks, withNamedLock } from "./store.js";
import { budgetExceededReason, budgetReferenceAlerts, readBudgetMarker, usageForBudgetGroup } from "./telemetry.js";
import { listCostAdjustments, readFxRateState } from "./adjustments.js";
import {
  effectiveBudget,
  listBudgetControlEvents,
  listBudgetOverrides,
  readOperatorControls,
} from "./controls.js";
import { managedLlamaServerStatus } from "./llama.js";
import { listSplitMemoryProfiles } from "./split-memory.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists, sleep, tailText } from "./util.js";
import { captureProcessIdentity, processIdentityMatches, signalVerifiedProcessGroup } from "./process-identity.js";
import { ensureOperatorToken } from "./security.js";

interface MonitorPidRecord {
  schemaVersion?: 2;
  pid: number;
  startedAt: string;
  configPath: string;
  baseUrl: string;
  identity?: ProcessIdentity;
  /** Legacy fields are read for cleanup only and never grant signal authority. */
  processStartTimeTicks?: string;
  /** Exact daemon module path expected in the process command line. */
  daemonPath?: string;
}

export interface LiveUsageEstimate {
  requestId: string;
  taskId: string;
  budgetGroupId: string;
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  costUsd: number;
  updatedAt: string;
}

interface GroupLiveUsage {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  costUsd: number;
  requestCount: number;
  updatedAt?: string;
}

function monitorDirectory(config: BridgeConfig): string {
  return path.join(config.stateRoot, "monitor");
}

function monitorPidPath(config: BridgeConfig): string {
  return path.join(monitorDirectory(config), "monitor.pid.json");
}

function monitorSnapshotPath(config: BridgeConfig): string {
  return path.join(monitorDirectory(config), "snapshot.json");
}

export function monitorBaseUrl(config: BridgeConfig): string {
  const host = config.monitor.host.includes(":") ? `[${config.monitor.host}]` : config.monitor.host;
  return `http://${host}:${config.monitor.port}`;
}

export async function pingMonitor(config: BridgeConfig): Promise<{ ok: boolean; pid?: number; baseUrl: string; error?: string }> {
  const baseUrl = monitorBaseUrl(config);
  try {
    const operatorToken = await ensureOperatorToken(config);
    const response = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${operatorToken}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return { ok: false, baseUrl, error: `monitor health returned HTTP ${response.status}` };
    const payload = await response.json() as Record<string, unknown>;
    const result: { ok: boolean; pid?: number; baseUrl: string; error?: string } = { ok: payload.ok === true, baseUrl };
    if (typeof payload.pid === "number" && Number.isInteger(payload.pid)) result.pid = payload.pid;
    if (!result.ok) result.error = "monitor health payload did not report ok=true";
    return result;
  } catch (error) {
    return { ok: false, baseUrl, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readPidRecord(config: BridgeConfig): Promise<MonitorPidRecord | undefined> {
  const target = monitorPidPath(config);
  if (!await pathExists(target)) return undefined;
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as MonitorPidRecord;
    return Number.isInteger(value.pid) && value.pid > 0 ? value : undefined;
  } catch { return undefined; }
}

/** A PID file is kill authority only when its recorded process identity still matches. */
async function pidRecordMatchesProcess(record: MonitorPidRecord): Promise<boolean> {
  return record.schemaVersion === 2
    && record.identity?.pid === record.pid
    && await processIdentityMatches(record.identity);
}

function monitorEnvironment(config: BridgeConfig, configPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(config.stateRoot, "monitor-home"),
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    CODEX_HARNESS_CONFIG: configPath,
  };
  for (const name of ["LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "LLAMA_CPP_API_KEY"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export async function ensureMonitorRunning(config: BridgeConfig, configPath: string): Promise<{ ok: boolean; pid?: number; baseUrl: string; started: boolean }> {
  if (!config.monitor.enabled) return { ok: true, baseUrl: monitorBaseUrl(config), started: false };
  return await withNamedLock(config, "monitor-start-stop", 30_000, async () => {
    const pidRecord = await readPidRecord(config);
    const existing = await pingMonitor(config);
    if (existing.ok) {
      if (!pidRecord || existing.pid !== pidRecord.pid || !await pidRecordMatchesProcess(pidRecord)) {
        throw new Error(`healthy monitor endpoint at ${existing.baseUrl} has no matching strong process identity`);
      }
      return { ok: true, pid: pidRecord.pid, baseUrl: existing.baseUrl, started: false };
    }
    if (pidRecord && await pidRecordMatchesProcess(pidRecord)) {
      throw new Error(`monitor PID ${pidRecord.pid} matches the recorded daemon but ${monitorBaseUrl(config)} is not healthy`);
    }
    await ensureDir(monitorDirectory(config));
    await rm(monitorPidPath(config), { force: true });
    const daemonPath = fileURLToPath(new URL("./monitor-daemon.js", import.meta.url));
    const logPath = path.join(monitorDirectory(config), "monitor.log");
    const logFd = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      env: monitorEnvironment(config, configPath),
      stdio: ["ignore", logFd, logFd],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("monitor daemon spawned without a PID");
      const identity = await captureProcessIdentity(child.pid);
      if (identity.processGroupId !== identity.pid) throw new Error("monitor daemon did not become its process-group leader");
      const record: MonitorPidRecord = {
        schemaVersion: 2,
        pid: child.pid,
        identity,
        startedAt: nowIso(),
        configPath,
        baseUrl: monitorBaseUrl(config),
        daemonPath,
      };
      await atomicWriteJson(monitorPidPath(config), record);
      child.unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = await pingMonitor(config);
        if (status.ok) return { ok: true, pid: child.pid, baseUrl: status.baseUrl, started: true };
        if (!await processIdentityMatches(identity)) break;
        await sleep(100);
      }
      await signalVerifiedProcessGroup(identity, "SIGTERM");
      throw new Error(`monitor daemon did not become healthy; inspect ${logPath}`);
    } finally { closeSync(logFd); }
  });
}

function zeroUsage(): UsageTotals {
  return {
    apiCalls: 0, completedCalls: 0, failedCalls: 0,
    inputTokens: 0, outputTokens: 0,
    estimatedInputTokens: 0, estimatedOutputTokens: 0,
    cacheHitInputTokens: 0, cacheMissInputTokens: 0,
    costCny: 0, costUsd: 0, unpricedCalls: 0,
  };
}

function addUsage(target: UsageTotals, usage: UsageTotals): void {
  target.apiCalls += usage.apiCalls;
  target.completedCalls += usage.completedCalls;
  target.failedCalls += usage.failedCalls;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.estimatedInputTokens += usage.estimatedInputTokens;
  target.estimatedOutputTokens += usage.estimatedOutputTokens;
  target.cacheHitInputTokens += usage.cacheHitInputTokens;
  target.cacheMissInputTokens += usage.cacheMissInputTokens;
  target.costCny += usage.costCny;
  target.costUsd += usage.costUsd;
  target.unpricedCalls += usage.unpricedCalls;
  if (usage.lastEventAt && (!target.lastEventAt || usage.lastEventAt > target.lastEventAt)) target.lastEventAt = usage.lastEventAt;
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

function groupLiveUsage(live: LiveUsageEstimate[]): Map<string, GroupLiveUsage> {
  const groups = new Map<string, GroupLiveUsage>();
  for (const item of live) {
    const current = groups.get(item.budgetGroupId) ?? { inputTokens: 0, outputTokens: 0, costCny: 0, costUsd: 0, requestCount: 0 };
    current.inputTokens += item.inputTokens;
    current.outputTokens += item.outputTokens;
    current.costCny += item.costCny;
    current.costUsd += item.costUsd;
    current.requestCount += 1;
    if (!current.updatedAt || item.updatedAt > current.updatedAt) current.updatedAt = item.updatedAt;
    groups.set(item.budgetGroupId, current);
  }
  for (const value of groups.values()) {
    value.costCny = rounded(value.costCny);
    value.costUsd = rounded(value.costUsd);
  }
  return groups;
}

function elapsedSeconds(task: TaskRecord): number | null {
  if (!task.startedAt) return null;
  const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1_000));
}

function percentage(current: number, maximum: number): number {
  return maximum > 0 ? Math.min(999, Number((current / maximum * 100).toFixed(2))) : 0;
}

function budgetProgress(usage: UsageTotals, live: GroupLiveUsage, budget: TaskBudget): Record<string, number> {
  const input = usage.inputTokens + usage.estimatedInputTokens + live.inputTokens;
  const output = usage.outputTokens + usage.estimatedOutputTokens + live.outputTokens;
  const cost = usage.costCny + live.costCny;
  return {
    apiCallsPercent: percentage(usage.apiCalls, budget.maxApiCalls),
    inputTokensPercent: percentage(input, budget.maxInputTokens),
    outputTokensPercent: percentage(output, budget.maxOutputTokens),
    costCnyPercent: percentage(cost, budget.maxCostCny),
  };
}

export async function buildMonitorSnapshot(config: BridgeConfig, limit = 100, live: LiveUsageEstimate[] = []): Promise<Record<string, unknown>> {
  const allTasks = await listTasks(config);
  const tasks = allTasks.slice(0, Math.max(1, Math.min(limit, 500)));
  const plans = await listPlans(config);
  const controls = await readOperatorControls(config);
  const overrides = await listBudgetOverrides(config);
  const controlAudit = await listBudgetControlEvents(config, 200);
  const fx = await readFxRateState(config);
  const adjustments = await listCostAdjustments(config, 5_000);
  const adjustmentByGroup = new Map<string, number>();
  for (const adjustment of adjustments) {
    let delta = adjustment.deltaCny ?? 0;
    if (adjustment.deltaCny === undefined && typeof adjustment.deltaUsd === "number" && fx.usdToCnyRate !== null) {
      delta = adjustment.deltaUsd * fx.usdToCnyRate;
    }
    adjustmentByGroup.set(adjustment.budgetGroupId, rounded((adjustmentByGroup.get(adjustment.budgetGroupId) ?? 0) + delta));
  }
  const liveByGroup = groupLiveUsage(live);
  const usageByGroup = new Map<string, UsageTotals>();
  const rows: Array<Record<string, unknown>> = [];
  const activeDetails: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    let usage = usageByGroup.get(task.budgetGroupId);
    if (!usage) {
      usage = await usageForBudgetGroup(config, task.budgetGroupId);
      usageByGroup.set(task.budgetGroupId, usage);
    }
    const budget = await effectiveBudget(config, task.budget, task.budgetGroupId);
    const liveUsage = liveByGroup.get(task.budgetGroupId) ?? { inputTokens: 0, outputTokens: 0, costCny: 0, costUsd: 0, requestCount: 0 };
    const currentReason = budgetExceededReason(usage, budget);
    const referenceAlerts = budgetReferenceAlerts(usage, budget);
    const marker = await readBudgetMarker(config, task.budgetGroupId);
    const manualAdjustmentCny = adjustmentByGroup.get(task.budgetGroupId) ?? 0;
    const adjustedFinalizedCostCny = rounded(usage.costCny + manualAdjustmentCny);
    const realtimeEstimatedCostCny = rounded(adjustedFinalizedCostCny + liveUsage.costCny);
    const row: Record<string, unknown> = {
      taskId: task.id,
      planId: task.planId,
      leafId: task.leafId,
      parentTaskId: task.parentTaskId,
      budgetGroupId: task.budgetGroupId,
      requestedExecutor: task.requestedExecutor ?? task.executor,
      plannedExecutor: task.executor,
      effectiveExecutor: task.effectiveExecutor ?? task.executor,
      routingReason: task.routingReason,
      fallbackUsed: task.fallbackUsed ?? false,
      fallbackReason: task.fallbackReason,
      fallbackModel: task.fallbackModel,
      phase: task.phase,
      status: task.status,
      objective: task.objective,
      model: task.model,
      complexity: task.complexity,
      harnessMode: task.harnessMode,
      parallelGroup: task.parallelGroup,
      dependsOn: task.dependsOn,
      taskFamily: task.taskFamily,
      splitDecision: task.splitDecision,
      mode: task.mode,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      elapsedSeconds: elapsedSeconds(task),
      budget,
      frozenBudget: task.budget,
      cumulativeUsage: usage,
      liveUsage,
      rawEstimatedCostCny: usage.costCny,
      manualAdjustmentCny,
      adjustedFinalizedCostCny,
      realtimeEstimatedCostCny,
      budgetProgress: budgetProgress(usage, liveUsage, budget),
      budgetGatePolicy: "input_output_tokens",
      budgetCeilingPolicy: budget.ceilingPolicy ?? "operator_bounded",
      budgetEnforcement: "hard",
      budgetState: currentReason ? "token_gate_exceeded" : "within_token_gate",
      budgetExceededReason: currentReason,
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
      historicalBudgetMarker: marker && !currentReason ? marker : undefined,
      dashboardUrl: task.dashboardUrl,
      executionAttempts: task.executionAttempts ?? [],
      changedPaths: task.changedPaths,
      outOfScopePaths: task.outOfScopePaths,
      error: task.error,
    };
    if (config.monitor.currency.showUsd) {
      row.rawEstimatedCostUsd = usage.costUsd;
      row.realtimeEstimatedCostUsd = rounded(usage.costUsd + liveUsage.costUsd);
      row.hiddenUsdSafetyCeiling = budget.maxCostUsd;
    }
    rows.push(row);

    if (task.status === "queued" || task.status === "running") {
      activeDetails.push({
        ...row,
        harnessWritePaths: task.harnessWritePaths,
        codexWritePaths: task.codexWritePaths,
        acceptanceCriteria: task.acceptanceCriteria,
        contextFiles: task.contextFiles,
        verificationCommands: task.verificationCommands,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        stdoutTail: await tailText(task.stdoutPath, 6_000),
        stderrTail: await tailText(task.stderrPath, 6_000),
      });
    }
  }

  const grand = zeroUsage();
  let grandAdjustmentCny = 0;
  let grandLiveCny = 0;
  let grandLiveUsd = 0;
  const allGroups = new Set(allTasks.map((task) => task.budgetGroupId));
  for (const group of allGroups) {
    let usage = usageByGroup.get(group);
    if (!usage) {
      usage = await usageForBudgetGroup(config, group);
      usageByGroup.set(group, usage);
    }
    addUsage(grand, usage);
    grandAdjustmentCny += adjustmentByGroup.get(group) ?? 0;
    grandLiveCny += liveByGroup.get(group)?.costCny ?? 0;
    grandLiveUsd += liveByGroup.get(group)?.costUsd ?? 0;
  }
  grand.costCny = rounded(grand.costCny);
  grand.costUsd = rounded(grand.costUsd);
  grandAdjustmentCny = rounded(grandAdjustmentCny);
  grandLiveCny = rounded(grandLiveCny);
  grandLiveUsd = rounded(grandLiveUsd);

  const snapshot: Record<string, unknown> = {
    schemaVersion: 6,
    serviceVersion: "0.6.6",
    generatedAt: nowIso(),
    pricingAsOf: config.monitor.pricingAsOf,
    costSemantics: "configured_pricing_estimate_cny_primary",
    billingAuthoritative: false,
    primaryCurrency: "CNY",
    currencySymbol: "CN¥",
    showUsd: config.monitor.currency.showUsd,
    finalizedRawCostCny: grand.costCny,
    manualAdjustmentCny: grandAdjustmentCny,
    liveEstimatedCostCny: grandLiveCny,
    totalCostCny: rounded(grand.costCny + grandAdjustmentCny + grandLiveCny),
    activeTaskCount: activeDetails.length,
    queuedTaskCount: allTasks.filter((task) => task.status === "queued").length,
    runningTaskCount: allTasks.filter((task) => task.status === "running").length,
    unpricedCalls: grand.unpricedCalls,
    cumulativeUsage: grand,
    plans: plans.slice(0, 100).map((plan) => ({ id: plan.id, status: plan.status, createdAt: plan.createdAt, updatedAt: plan.updatedAt, leafCount: plan.leaves.length })),
    tasks: rows,
    activeTasks: activeDetails,
    budgetControls: {
      installationCeiling: config.controller.maximumHarnessBudget,
      proComplexExecutionHasHardTokenGates: true,
      apiCallsAndCostAreReferenceOnly: true,
      policy: controls.budgetPolicy,
      overrides,
      recentAudit: controlAudit.slice().reverse(),
      updatedAt: controls.updatedAt,
      updatedBy: controls.updatedBy,
    },
    adaptiveSplitMemory: {
      enabled: config.controller.splitMemory.enabled,
      profiles: (await listSplitMemoryProfiles(config)).slice(0, 100),
    },
    llamaCpp: await managedLlamaServerStatus(config, false),
    costAdjustments: adjustments.slice(-200).reverse(),
    budgetUsesManualAdjustments: false,
  };
  if (config.monitor.currency.showUsd) {
    snapshot.finalizedRawCostUsd = grand.costUsd;
    snapshot.liveEstimatedCostUsd = grandLiveUsd;
    snapshot.totalCostUsd = rounded(grand.costUsd + grandLiveUsd);
    snapshot.currency = fx;
  }
  return snapshot;
}

export async function persistMonitorSnapshot(config: BridgeConfig, live: LiveUsageEstimate[] = []): Promise<Record<string, unknown>> {
  const snapshot = await buildMonitorSnapshot(config, 100, live);
  await ensureDir(monitorDirectory(config));
  await atomicWriteJson(monitorSnapshotPath(config), snapshot);
  return snapshot;
}

export async function stopMonitor(config: BridgeConfig): Promise<{ ok: boolean; stopped: boolean; pid?: number; baseUrl: string }> {
  return await withNamedLock(config, "monitor-start-stop", 30_000, async () => {
    const record = await readPidRecord(config);
    const healthy = await pingMonitor(config);
    if (!record || !await pidRecordMatchesProcess(record)) {
      await rm(monitorPidPath(config), { force: true });
      return { ok: true, stopped: false, baseUrl: monitorBaseUrl(config) };
    }
    const identity = record.identity!;
    if (healthy.ok && healthy.pid !== identity.pid) {
      throw new Error("healthy monitor endpoint PID does not match the recorded process identity");
    }
    const pid = identity.pid;
    await signalVerifiedProcessGroup(identity, "SIGTERM");
    const gracefulDeadline = Date.now() + 3_000;
    while (Date.now() < gracefulDeadline && await processIdentityMatches(identity)) await sleep(50);
    if (await processIdentityMatches(identity)) {
      await signalVerifiedProcessGroup(identity, "SIGKILL");
      const killDeadline = Date.now() + 1_000;
      while (Date.now() < killDeadline && await processIdentityMatches(identity)) await sleep(25);
    }
    await rm(monitorPidPath(config), { force: true });
    return { ok: !await processIdentityMatches(identity), stopped: true, pid, baseUrl: monitorBaseUrl(config) };
  });
}
