import { closeSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPlans, listTasks, withNamedLock } from "./store.js";
import { budgetExceededReason, budgetReferenceAlerts, readBudgetMarker, usageForBudgetGroup } from "./telemetry.js";
import { listCostAdjustments, readFxRateState } from "./adjustments.js";
import { effectiveBudget, listBudgetControlEvents, listBudgetOverrides, readOperatorControls, } from "./controls.js";
import { managedLlamaServerStatus } from "./llama.js";
import { listSplitMemoryProfiles } from "./split-memory.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists, processAlive, sleep, tailText } from "./util.js";
function monitorDirectory(config) {
    return path.join(config.stateRoot, "monitor");
}
function monitorPidPath(config) {
    return path.join(monitorDirectory(config), "monitor.pid.json");
}
function monitorSnapshotPath(config) {
    return path.join(monitorDirectory(config), "snapshot.json");
}
export function monitorBaseUrl(config) {
    const host = config.monitor.host.includes(":") ? `[${config.monitor.host}]` : config.monitor.host;
    return `http://${host}:${config.monitor.port}`;
}
export async function pingMonitor(config) {
    const baseUrl = monitorBaseUrl(config);
    try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
        if (!response.ok)
            return { ok: false, baseUrl, error: `monitor health returned HTTP ${response.status}` };
        const payload = await response.json();
        const result = { ok: payload.ok === true, baseUrl };
        if (typeof payload.pid === "number" && Number.isInteger(payload.pid))
            result.pid = payload.pid;
        if (!result.ok)
            result.error = "monitor health payload did not report ok=true";
        return result;
    }
    catch (error) {
        return { ok: false, baseUrl, error: error instanceof Error ? error.message : String(error) };
    }
}
async function readPidRecord(config) {
    const target = monitorPidPath(config);
    if (!await pathExists(target))
        return undefined;
    try {
        const value = JSON.parse(await readFile(target, "utf8"));
        return Number.isInteger(value.pid) && value.pid > 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Read identity that survives PID reuse. Missing /proc support degrades to undefined. */
async function processIdentity(pid) {
    if (!processAlive(pid))
        return undefined;
    if (process.platform !== "linux")
        return {};
    try {
        const statText = await readFile(`/proc/${pid}/stat`, "utf8");
        const close = statText.lastIndexOf(")");
        if (close < 0)
            return undefined;
        // Fields after the command name begin at field 3; starttime is field 22.
        const fields = statText.slice(close + 2).trim().split(/\s+/);
        const startTimeTicks = fields[19];
        const commandLine = (await readFile(`/proc/${pid}/cmdline`))
            .toString("utf8").split("\0").filter(Boolean);
        return {
            ...(startTimeTicks ? { startTimeTicks } : {}),
            ...(commandLine.length > 0 ? { commandLine } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/** A PID file is kill authority only when its recorded process identity still matches. */
async function pidRecordMatchesProcess(record) {
    const identity = await processIdentity(record.pid);
    if (!identity)
        return false;
    // Legacy records have no anti-reuse identity. They may be observed through
    // the health endpoint, but must never authorize a raw signal by PID alone.
    if (!record.processStartTimeTicks && !record.daemonPath)
        return false;
    if (record.processStartTimeTicks && identity.startTimeTicks !== record.processStartTimeTicks)
        return false;
    if (record.daemonPath) {
        const expected = path.resolve(record.daemonPath);
        if (!identity.commandLine?.some((value) => path.resolve(value) === expected))
            return false;
    }
    return true;
}
export async function ensureMonitorRunning(config, configPath) {
    if (!config.monitor.enabled)
        return { ok: true, baseUrl: monitorBaseUrl(config), started: false };
    return await withNamedLock(config, "monitor-start-stop", 30_000, async () => {
        const existing = await pingMonitor(config);
        if (existing.ok)
            return { ok: true, ...(existing.pid === undefined ? {} : { pid: existing.pid }), baseUrl: existing.baseUrl, started: false };
        const pidRecord = await readPidRecord(config);
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
            env: { ...process.env, CODEX_HARNESS_CONFIG: configPath },
            stdio: ["ignore", logFd, logFd],
        });
        try {
            await new Promise((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            if (!child.pid)
                throw new Error("monitor daemon spawned without a PID");
            const identity = await processIdentity(child.pid);
            const record = {
                pid: child.pid,
                startedAt: nowIso(),
                configPath,
                baseUrl: monitorBaseUrl(config),
                ...(identity?.startTimeTicks ? { processStartTimeTicks: identity.startTimeTicks } : {}),
                daemonPath,
            };
            await writeFile(monitorPidPath(config), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
            child.unref();
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                const status = await pingMonitor(config);
                if (status.ok)
                    return { ok: true, pid: child.pid, baseUrl: status.baseUrl, started: true };
                if (!processAlive(child.pid))
                    break;
                await sleep(100);
            }
            try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch {
                try {
                    process.kill(child.pid, "SIGTERM");
                }
                catch { /* gone */ }
            }
            throw new Error(`monitor daemon did not become healthy; inspect ${logPath}`);
        }
        finally {
            closeSync(logFd);
        }
    });
}
function zeroUsage() {
    return {
        apiCalls: 0, completedCalls: 0, failedCalls: 0,
        inputTokens: 0, outputTokens: 0,
        estimatedInputTokens: 0, estimatedOutputTokens: 0,
        cacheHitInputTokens: 0, cacheMissInputTokens: 0,
        costCny: 0, costUsd: 0, unpricedCalls: 0,
    };
}
function addUsage(target, usage) {
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
    if (usage.lastEventAt && (!target.lastEventAt || usage.lastEventAt > target.lastEventAt))
        target.lastEventAt = usage.lastEventAt;
}
function rounded(value) {
    return Number(value.toFixed(12));
}
function groupLiveUsage(live) {
    const groups = new Map();
    for (const item of live) {
        const current = groups.get(item.budgetGroupId) ?? { inputTokens: 0, outputTokens: 0, costCny: 0, costUsd: 0, requestCount: 0 };
        current.inputTokens += item.inputTokens;
        current.outputTokens += item.outputTokens;
        current.costCny += item.costCny;
        current.costUsd += item.costUsd;
        current.requestCount += 1;
        if (!current.updatedAt || item.updatedAt > current.updatedAt)
            current.updatedAt = item.updatedAt;
        groups.set(item.budgetGroupId, current);
    }
    for (const value of groups.values()) {
        value.costCny = rounded(value.costCny);
        value.costUsd = rounded(value.costUsd);
    }
    return groups;
}
function elapsedSeconds(task) {
    if (!task.startedAt)
        return null;
    const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
    const start = Date.parse(task.startedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return null;
    return Math.max(0, Math.floor((end - start) / 1_000));
}
function percentage(current, maximum) {
    return maximum > 0 ? Math.min(999, Number((current / maximum * 100).toFixed(2))) : 0;
}
function budgetProgress(usage, live, budget) {
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
export async function buildMonitorSnapshot(config, limit = 100, live = []) {
    const allTasks = await listTasks(config);
    const tasks = allTasks.slice(0, Math.max(1, Math.min(limit, 500)));
    const plans = await listPlans(config);
    const controls = await readOperatorControls(config);
    const overrides = await listBudgetOverrides(config);
    const controlAudit = await listBudgetControlEvents(config, 200);
    const fx = await readFxRateState(config);
    const adjustments = await listCostAdjustments(config, 5_000);
    const adjustmentByGroup = new Map();
    for (const adjustment of adjustments) {
        let delta = adjustment.deltaCny ?? 0;
        if (adjustment.deltaCny === undefined && typeof adjustment.deltaUsd === "number" && fx.usdToCnyRate !== null) {
            delta = adjustment.deltaUsd * fx.usdToCnyRate;
        }
        adjustmentByGroup.set(adjustment.budgetGroupId, rounded((adjustmentByGroup.get(adjustment.budgetGroupId) ?? 0) + delta));
    }
    const liveByGroup = groupLiveUsage(live);
    const usageByGroup = new Map();
    const rows = [];
    const activeDetails = [];
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
        const row = {
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
    const snapshot = {
        schemaVersion: 6,
        serviceVersion: "0.6.4",
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
export async function persistMonitorSnapshot(config, live = []) {
    const snapshot = await buildMonitorSnapshot(config, 100, live);
    await ensureDir(monitorDirectory(config));
    await atomicWriteJson(monitorSnapshotPath(config), snapshot);
    return snapshot;
}
export async function stopMonitor(config) {
    return await withNamedLock(config, "monitor-start-stop", 30_000, async () => {
        const record = await readPidRecord(config);
        const healthy = await pingMonitor(config);
        let pid;
        if (healthy.ok && healthy.pid) {
            // The configured loopback health endpoint reports the daemon's own PID.
            pid = healthy.pid;
        }
        else if (record && await pidRecordMatchesProcess(record)) {
            pid = record.pid;
        }
        if (!pid || !processAlive(pid)) {
            await rm(monitorPidPath(config), { force: true });
            return { ok: true, stopped: false, baseUrl: monitorBaseUrl(config) };
        }
        try {
            if (process.platform !== "win32")
                process.kill(-pid, "SIGTERM");
            else
                process.kill(pid, "SIGTERM");
        }
        catch {
            try {
                process.kill(pid, "SIGTERM");
            }
            catch { /* gone */ }
        }
        const gracefulDeadline = Date.now() + 3_000;
        while (Date.now() < gracefulDeadline && processAlive(pid))
            await sleep(50);
        if (processAlive(pid)) {
            // Re-check identity before escalation: a just-exited daemon's PID may
            // already have been reused during the grace window.
            const stillOwned = healthy.ok || (record !== undefined && await pidRecordMatchesProcess(record));
            if (stillOwned) {
                try {
                    if (process.platform !== "win32")
                        process.kill(-pid, "SIGKILL");
                    else
                        process.kill(pid, "SIGKILL");
                }
                catch { /* gone */ }
                const killDeadline = Date.now() + 1_000;
                while (Date.now() < killDeadline && processAlive(pid))
                    await sleep(25);
            }
        }
        await rm(monitorPidPath(config), { force: true });
        return { ok: !processAlive(pid), stopped: true, pid, baseUrl: monitorBaseUrl(config) };
    });
}
//# sourceMappingURL=monitor.js.map