import { chmod, copyFile, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { assertTaskWorktreeIdentity, changedPaths, findOutOfScope, resolveCommit, stagedPaths, unsafeChangedGitlinkPaths, unsafeChangedSymlinkPaths, } from "./git.js";
import { assertHarnessProvenance } from "./service.js";
import { loadTask, taskDirectory, updatePlan, updateTask } from "./store.js";
import { persistMonitorSnapshot } from "./monitor.js";
import { LlamaExecutionError, runLlamaTask } from "./llama.js";
import { effectiveBudget, effectiveLlamaConfig } from "./controls.js";
import { budgetExceededReason, budgetReferenceAlerts, readBudgetMarker, usageForBudgetGroup, writeUsageSnapshot } from "./telemetry.js";
import { recordTaskSplitOutcome } from "./split-memory.js";
import { isWithin, nowIso, pathExists, sleep, tailText } from "./util.js";
import { attemptInfrastructureAbortReason, classifyMinimalToolPlaneFailure } from "./infrastructure-failure.js";
import { createExecutionAttempt, thinkingPolicyForModel } from "./thinking-policy.js";
import { cleanupHarnessSandbox, prepareHarnessSandbox } from "./harness-isolation.js";
import { captureProcessIdentity, signalVerifiedProcessGroup } from "./process-identity.js";
const MAX_WORKER_LOG_BYTES = 20_000_000;
const ATTEMPT_ABORT_POLL_MS = 100;
function containsToolProtocolLeak(text) {
    return /<(?:(?:｜|\|)DSML(?:｜|\|))?(?:tool_calls|invoke|parameter)\b/iu.test(text)
        || /<｜tool[▁_ ]?calls[▁_ ]?begin｜>/iu.test(text)
        || /<(?:tool[_-]?calls?|function[_-]?calls?)\b/iu.test(text)
        || /\[Calling[ \t]+tool:[ \t]*[A-Za-z0-9_-]+[ \t]+with[ \t]+arguments:/iu.test(text)
        || /(?:^|\n)[ \t]*(?:bash|pwsh|str_replace_editor)(?:[ \t]+tool[_ -]?call)?[ \t]*:?\s*(?:\n|\{)/iu.test(text);
}
function containsExecutableMarkdownFence(text) {
    return /```[ \t]*(?:bash|sh|shell|zsh|pwsh|powershell)\b(?:[^\r\n]*)\r?\n/iu.test(text);
}
function requiresRepositoryChange(task) {
    return task.harnessWritePaths.length > 0 && ["implementation", "test", "repair"].includes(task.mode);
}
async function waitForActivation(target) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await pathExists(target))
            return;
        await sleep(25);
    }
    throw new Error(`worker activation signal was not published: ${target}`);
}
async function assertSafeWorkspaceEnvironment(worktreePath) {
    const target = path.join(worktreePath, ".env");
    if (!await pathExists(target))
        return;
    throw new Error("workspace .env is forbidden for Harness tasks; supply bounded non-secret context explicitly");
}
async function writeAll(handle, data) {
    let offset = 0;
    while (offset < data.length) {
        const { bytesWritten } = await handle.write(data, offset, data.length - offset);
        if (bytesWritten <= 0)
            throw new Error("log writer made no progress");
        offset += bytesWritten;
    }
}
async function captureBoundedLog(input, target, streamName, onLimit) {
    if (!input)
        return;
    const output = await open(target, "a", 0o600);
    let written = 0;
    let limited = false;
    try {
        for await (const value of input) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            if (limited)
                continue;
            const remaining = MAX_WORKER_LOG_BYTES - written;
            if (remaining > 0) {
                const slice = chunk.subarray(0, remaining);
                await writeAll(output, slice);
                written += slice.length;
            }
            if (chunk.length > remaining) {
                limited = true;
                const message = `worker ${streamName} exceeded ${MAX_WORKER_LOG_BYTES} bytes`;
                await writeAll(output, Buffer.from(`\n[${message}; terminating task]\n`));
                onLimit(message);
            }
        }
    }
    finally {
        await output.close();
    }
}
function terminateChild(child, identity) {
    void signalVerifiedProcessGroup(identity, "SIGTERM");
    const escalation = setTimeout(() => { void signalVerifiedProcessGroup(identity, "SIGKILL"); }, 5_000);
    escalation.unref();
    child.once("close", () => clearTimeout(escalation));
}
async function runHarness(taskId, forcedModel) {
    const config = await loadConfig();
    const task = await loadTask(config, taskId);
    const launcher = await assertHarnessProvenance(config);
    const profile = task.harnessMode === "minimal" ? config.harnessMinimalProfile : config.harnessProfile;
    const selectedModel = forcedModel ?? task.model;
    const activeAttempt = task.executionAttempts?.at(-1);
    if (selectedModel !== undefined && thinkingPolicyForModel(selectedModel, activeAttempt?.startedAt ?? nowIso()) !== undefined) {
        if (activeAttempt?.thinkingPolicy === undefined || activeAttempt.model !== selectedModel) {
            throw new Error(`Harness attempt has no immutable thinking policy for ${selectedModel}`);
        }
    }
    if (!config.monitor.enabled)
        throw new Error("Harness requires the credential-brokering monitor proxy");
    const prepared = await prepareHarnessSandbox(config, task, launcher, profile, selectedModel);
    // Keep a pinned Node supervisor as the detached process-group leader. The
    // trusted Bubblewrap launcher can then exec or complete very quickly without
    // invalidating the lifetime identity used for abort/timeout cleanup.
    const supervisorPath = fileURLToPath(new URL("./run-process-supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [supervisorPath], {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
    });
    const outcomePromise = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        child.once("error", (error) => finish({ code: null, error: error.message }));
        child.on("message", (raw) => {
            const message = raw;
            if (message?.type === "command-error")
                finish({ code: null, error: message.error ?? "Bubblewrap failed to spawn" });
            else if (message?.type === "command-result") {
                finish({
                    code: message.code ?? null,
                    ...(message.signal ? { error: `Bubblewrap exited on ${message.signal}` } : {}),
                });
            }
        });
        child.once("close", (exitCode, signal) => finish({
            code: exitCode,
            error: `Harness supervisor exited before command result${signal ? ` on ${signal}` : ""}`,
        }));
    });
    let identity;
    try {
        identity = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("spawn", () => {
                if (!child.pid)
                    return reject(new Error("Harness supervisor spawned without PID"));
                void captureProcessIdentity(child.pid).then(resolve, reject);
            });
        });
    }
    catch (error) {
        child.disconnect();
        await cleanupHarnessSandbox(prepared.sandboxRoot);
        throw error;
    }
    if (identity.processGroupId !== identity.pid) {
        child.disconnect();
        await cleanupHarnessSandbox(prepared.sandboxRoot);
        throw new Error("Harness supervisor did not become its process-group leader");
    }
    child.send({
        type: "start",
        command: prepared.command,
        args: prepared.args,
        cwd: task.worktreePath,
        env: prepared.env,
    });
    let outputLimitError;
    const limitTask = (message) => {
        outputLimitError ??= message;
        terminateChild(child, identity);
    };
    const stdoutCapture = captureBoundedLog(child.stdout, task.stdoutPath, "stdout", limitTask);
    const stderrCapture = captureBoundedLog(child.stderr, task.stderrPath, "stderr", limitTask);
    let timer;
    let timedOut = false;
    let stopAbortWatch = false;
    let attemptAbortError;
    let abortWatchError;
    let abortWatch;
    try {
        let cancelledAfterSpawn = false;
        if (child.pid !== undefined) {
            const childPid = child.pid;
            await updateTask(config, taskId, (current) => {
                if (current.status === "cancelled") {
                    cancelledAfterSpawn = true;
                    return;
                }
                if (current.status !== "running")
                    throw new Error(`worker lost task ownership in status ${current.status}`);
                current.harnessPid = childPid;
                current.harnessIdentity = identity;
            });
        }
        if (cancelledAfterSpawn)
            terminateChild(child, identity);
        abortWatch = (async () => {
            while (!stopAbortWatch) {
                const current = await loadTask(config, taskId);
                if (current.status !== "running")
                    return;
                const reason = attemptInfrastructureAbortReason(current);
                if (reason !== undefined) {
                    attemptAbortError = reason;
                    terminateChild(child, identity);
                    return;
                }
                await sleep(ATTEMPT_ABORT_POLL_MS);
            }
        })().catch((error) => {
            abortWatchError = `attempt abort watcher failed: ${error instanceof Error ? error.message : String(error)}`;
            terminateChild(child, identity);
        });
        timer = setTimeout(() => { timedOut = true; terminateChild(child, identity); }, task.runtimeSeconds * 1_000);
        timer.unref();
        const outcome = await outcomePromise;
        await signalVerifiedProcessGroup(identity, "SIGKILL");
        stopAbortWatch = true;
        if (abortWatch) {
            await abortWatch;
            abortWatch = undefined;
        }
        const finalTaskState = await loadTask(config, taskId);
        attemptAbortError ??= attemptInfrastructureAbortReason(finalTaskState);
        const result = { code: outcome.code, timedOut };
        const launchError = attemptAbortError ?? abortWatchError ?? outcome.error ?? outputLimitError;
        if (launchError)
            result.launchError = launchError;
        return result;
    }
    finally {
        stopAbortWatch = true;
        if (timer)
            clearTimeout(timer);
        if (abortWatch)
            await abortWatch;
        await Promise.all([stdoutCapture, stderrCapture]);
        await cleanupHarnessSandbox(prepared.sandboxRoot);
    }
}
function attempt(executor, model, ordinal) {
    return createExecutionAttempt(executor, model, ordinal, nowIso());
}
async function finishLastAttempt(taskId, outcome, error) {
    const config = await loadConfig();
    await updateTask(config, taskId, (current) => {
        const attempts = current.executionAttempts ?? [];
        const latest = attempts.at(-1);
        if (!latest || latest.completedAt)
            return;
        latest.completedAt = nowIso();
        latest.outcome = outcome;
        if (error)
            latest.error = error;
        current.executionAttempts = attempts;
    });
}
function localSnapshotRoot(config, task) {
    return path.join(taskDirectory(config, task.id), "local-lease-baseline");
}
async function snapshotLocalLeases(config, task) {
    const root = localSnapshotRoot(config, task);
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "files"), { recursive: true, mode: 0o700 });
    const entries = [];
    for (const [index, rawRelative] of task.harnessWritePaths.entries()) {
        if (rawRelative === "**" || rawRelative.endsWith("/**"))
            throw new Error("llama.cpp fallback requires exact output leases");
        const relative = rawRelative.replace(/\\/g, "/");
        const target = path.resolve(task.worktreePath, relative);
        if (!isWithin(target, task.worktreePath))
            throw new Error(`local snapshot path escapes worktree: ${relative}`);
        if (!await pathExists(target)) {
            entries.push({ relative, existed: false });
            continue;
        }
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`llama.cpp output baseline must be a regular file: ${relative}`);
        const backupFile = path.join("files", `${String(index).padStart(4, "0")}.bin`);
        await copyFile(target, path.join(root, backupFile));
        await chmod(path.join(root, backupFile), 0o600);
        entries.push({ relative, existed: true, backupFile, mode: info.mode & 0o777 });
    }
    const snapshot = { schemaVersion: 1, taskId: task.id, capturedAt: nowIso(), entries };
    await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return snapshot;
}
async function restoreLocalLeases(config, task, snapshot) {
    if (snapshot.taskId !== task.id)
        throw new Error("llama.cpp fallback snapshot task identity mismatch");
    const root = localSnapshotRoot(config, task);
    for (const entry of snapshot.entries) {
        const target = path.resolve(task.worktreePath, entry.relative);
        if (!isWithin(target, task.worktreePath))
            throw new Error(`fallback restore path escapes worktree: ${entry.relative}`);
        if (!entry.existed) {
            await rm(target, { recursive: true, force: true });
            continue;
        }
        if (!entry.backupFile)
            throw new Error(`fallback snapshot is missing backup identity: ${entry.relative}`);
        const backup = path.resolve(root, entry.backupFile);
        if (!isWithin(backup, root))
            throw new Error(`fallback snapshot backup escapes state root: ${entry.relative}`);
        const backupInfo = await lstat(backup);
        if (!backupInfo.isFile() || backupInfo.isSymbolicLink())
            throw new Error(`fallback snapshot backup is unsafe: ${entry.relative}`);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        const temporary = `${target}.codex-harness-restore-${process.pid}.tmp`;
        try {
            await copyFile(backup, temporary);
            await chmod(temporary, entry.mode ?? 0o600);
            await rm(target, { recursive: true, force: true });
            await (await import("node:fs/promises")).rename(temporary, target);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
async function assertFallbackSafeAndRestore(config, task, snapshot) {
    await assertTaskWorktreeIdentity(task);
    const head = await resolveCommit(task.worktreePath, "HEAD");
    if (head !== task.startingHeadCommit)
        throw new Error("llama.cpp fallback refused because the local executable changed Git HEAD");
    const currentPaths = await changedPaths(task.worktreePath, task.baseCommit);
    const violations = findOutOfScope(currentPaths, task.harnessWritePaths);
    const unsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, currentPaths);
    const unsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, currentPaths);
    const staged = await stagedPaths(task.worktreePath);
    if (violations.length || unsafeSymlinks.length || unsafeGitlinks.length || staged.length) {
        throw new Error(`llama.cpp fallback refused after unsafe local changes: ${JSON.stringify({ violations, unsafeSymlinks, unsafeGitlinks, staged })}`);
    }
    await restoreLocalLeases(config, task, snapshot);
    const restoredPaths = await changedPaths(task.worktreePath, task.baseCommit);
    const restoredViolations = findOutOfScope(restoredPaths, task.harnessWritePaths);
    const restoredUnsafeSymlinks = await unsafeChangedSymlinkPaths(task.worktreePath, restoredPaths);
    const restoredUnsafeGitlinks = await unsafeChangedGitlinkPaths(task.worktreePath, restoredPaths);
    const restoredStaged = await stagedPaths(task.worktreePath);
    if (restoredViolations.length || restoredUnsafeSymlinks.length || restoredUnsafeGitlinks.length || restoredStaged.length) {
        throw new Error(`llama.cpp fallback baseline restoration failed safety validation: ${JSON.stringify({ restoredViolations, restoredUnsafeSymlinks, restoredUnsafeGitlinks, restoredStaged })}`);
    }
}
async function main() {
    const taskId = process.argv[2];
    const activationPath = process.argv[3];
    const readyPath = process.argv[4];
    if (!taskId || !activationPath || !readyPath)
        throw new Error("worker requires task id, activation path, and readiness path");
    await waitForActivation(activationPath);
    const config = await loadConfig();
    const workerIdentity = await captureProcessIdentity(process.pid);
    if (workerIdentity.processGroupId !== workerIdentity.pid)
        throw new Error("worker did not become its process-group leader");
    const task = await updateTask(config, taskId, (current) => {
        if (current.status === "cancelled")
            return;
        if (current.status !== "queued")
            throw new Error(`worker cannot start task in status ${current.status}`);
        current.status = "running";
        current.phase = current.mode === "repair" ? current.phase ?? "repair" : "execution";
        current.startedAt = nowIso();
        current.workerPid = process.pid;
        current.workerIdentity = workerIdentity;
        delete current.workerDeadObservedAt;
        current.effectiveExecutor = current.executor;
        current.executionAttempts = [attempt(current.executor, current.model, 1)];
    });
    if (task.status === "cancelled")
        return;
    await writeFile(readyPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    await assertTaskWorktreeIdentity(task);
    const actualStartingHead = await resolveCommit(task.worktreePath, "HEAD");
    if (actualStartingHead !== task.startingHeadCommit)
        throw new Error(`worker expected HEAD ${task.startingHeadCommit}, got ${actualStartingHead}`);
    await assertSafeWorkspaceEnvironment(task.worktreePath);
    let code = null;
    let launchError;
    let timedOut = false;
    if (task.executor === "harness") {
        const result = await runHarness(taskId);
        code = result.code;
        timedOut = result.timedOut;
        launchError = result.launchError;
        await finishLastAttempt(taskId, timedOut ? "timed_out" : code === 0 && launchError === undefined ? "completed" : "failed", launchError);
    }
    else {
        const localBaseline = await snapshotLocalLeases(config, task);
        try {
            const result = await runLlamaTask(config, task);
            await writeFile(task.stdoutPath, `${result.summary}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
            code = 0;
            await finishLastAttempt(taskId, "completed");
        }
        catch (error) {
            const selected = error instanceof LlamaExecutionError
                ? error
                : new LlamaExecutionError("process", error instanceof Error ? error.message : String(error));
            await writeFile(task.stderrPath, `[llama.cpp failed] ${selected.message}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
            await finishLastAttempt(taskId, selected.code === "timeout" ? "timed_out" : "failed", selected.message);
            const llama = await effectiveLlamaConfig(config);
            if (selected.fallbackEligible && llama.fallbackEnabled) {
                try {
                    const latest = await loadTask(config, taskId);
                    await assertFallbackSafeAndRestore(config, latest, localBaseline);
                    await assertHarnessProvenance(config);
                    await updateTask(config, taskId, (current) => {
                        if (current.status !== "running")
                            throw new Error(`fallback lost task ownership in status ${current.status}`);
                        current.fallbackUsed = true;
                        current.fallbackReason = selected.message;
                        current.fallbackModel = llama.fallbackModel;
                        current.effectiveExecutor = "harness";
                        current.phase = "fallback-harness";
                        const ordinal = (current.executionAttempts?.length ?? 0) + 1;
                        current.executionAttempts = [...(current.executionAttempts ?? []), attempt("harness", llama.fallbackModel, ordinal)];
                    });
                    await writeFile(task.stderrPath, `[fallback] switching to Harness model ${llama.fallbackModel}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
                    const result = await runHarness(taskId, llama.fallbackModel);
                    code = result.code;
                    timedOut = result.timedOut;
                    launchError = result.launchError;
                    await finishLastAttempt(taskId, timedOut ? "timed_out" : code === 0 && launchError === undefined ? "completed" : "failed", launchError);
                }
                catch (fallbackError) {
                    code = 1;
                    const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                    launchError = `llama.cpp failed (${selected.message}); Harness fallback failed (${message})`;
                    await writeFile(task.stderrPath, `${launchError}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
                    await finishLastAttempt(taskId, "failed", message);
                }
            }
            else {
                code = 1;
                launchError = selected.message;
            }
        }
    }
    const latest = await loadTask(config, taskId);
    if (latest.status === "cancelled")
        return;
    await assertTaskWorktreeIdentity(latest);
    const finalHead = await resolveCommit(latest.worktreePath, "HEAD");
    const unauthorizedCommit = finalHead !== latest.startingHeadCommit;
    const finalPaths = await changedPaths(latest.worktreePath, latest.baseCommit);
    const finalViolations = findOutOfScope(finalPaths, latest.harnessWritePaths);
    const finalUnsafeSymlinks = await unsafeChangedSymlinkPaths(latest.worktreePath, finalPaths);
    const finalUnsafeGitlinks = await unsafeChangedGitlinkPaths(latest.worktreePath, finalPaths);
    const finalStaged = await stagedPaths(latest.worktreePath);
    const resultSummary = await tailText(latest.stdoutPath, config.logTailChars);
    const errorSummary = await tailText(latest.stderrPath, config.logTailChars);
    const stateToolPlaneFailure = latest.infrastructureFailureKind === "minimal_tool_plane"
        || latest.infrastructureFailureKind === "minimal_tool_plane_composition"
        || latest.infrastructureFailureKind === "minimal_tool_serialization_mismatch";
    const inferredToolPlaneFailure = classifyMinimalToolPlaneFailure(latest, [launchError, errorSummary].filter((value) => Boolean(value)).join("\n"));
    const minimalToolPlaneFailure = latest.executor === "harness"
        && latest.harnessMode === "minimal"
        && (stateToolPlaneFailure || inferredToolPlaneFailure !== undefined);
    const leakedToolProtocol = latest.executor === "harness"
        && latest.harnessMode === "minimal"
        && finalPaths.length === 0
        && (containsToolProtocolLeak(resultSummary) || containsToolProtocolLeak(errorSummary)
            || containsExecutableMarkdownFence(resultSummary) || containsExecutableMarkdownFence(errorSummary));
    const requiredChangeExpected = finalPaths.length === 0 && requiresRepositoryChange(latest);
    const totals = await usageForBudgetGroup(config, latest.budgetGroupId);
    const budget = await effectiveBudget(config, latest.budget, latest.budgetGroupId);
    // Actual totals can remain within the ceiling when the proxy rejects the
    // *next* request. Preserve that valid projection failure unless a live UI
    // budget change has already reconciled and removed its marker.
    const budgetMarker = await readBudgetMarker(config, latest.budgetGroupId);
    const budgetError = budgetExceededReason(totals, budget) ?? budgetMarker?.reason;
    const referenceAlerts = budgetReferenceAlerts(totals, budget);
    const requiredChangeMissing = requiredChangeExpected
        && code === 0
        && !timedOut
        && launchError === undefined
        && budgetError === undefined
        && !unauthorizedCommit
        && finalViolations.length === 0
        && finalUnsafeSymlinks.length === 0
        && finalUnsafeGitlinks.length === 0
        && finalStaged.length === 0
        && !minimalToolPlaneFailure
        && !leakedToolProtocol
        && latest.infrastructureFailureKind === undefined;
    const completed = await updateTask(config, taskId, (current) => {
        if (current.status === "cancelled")
            return;
        if (current.status !== "running")
            throw new Error(`worker cannot publish completion over status ${current.status}`);
        current.exitCode = code;
        delete current.workerDeadObservedAt;
        current.completedAt = nowIso();
        current.phase = "completed";
        current.changedPaths = finalPaths;
        current.outOfScopePaths = finalViolations;
        current.unsafeSymlinkPaths = finalUnsafeSymlinks;
        current.unsafeGitlinkPaths = finalUnsafeGitlinks;
        current.stagedPaths = finalStaged;
        current.resultSummary = resultSummary;
        current.referenceAlerts = referenceAlerts;
        if (minimalToolPlaneFailure && current.infrastructureFailureKind === undefined) {
            current.infrastructureFailureKind = inferredToolPlaneFailure ?? "minimal_tool_plane_composition";
            current.infrastructureFailureDetails = [launchError, errorSummary]
                .filter((value) => Boolean(value))
                .join("\n");
        }
        else if (leakedToolProtocol) {
            current.infrastructureFailureKind = "tool_protocol";
            current.infrastructureFailureDetails = "minimal Harness emitted executable DSML, textual tool-call markup, or Markdown shell text instead of dispatching a structured tool call, and produced no repository diff";
            current.toolProtocolFailure = current.toolProtocolFailure ?? current.infrastructureFailureDetails;
            current.toolProtocolFailureAt = current.toolProtocolFailureAt ?? nowIso();
        }
        else if (requiredChangeMissing && current.infrastructureFailureKind === undefined) {
            current.infrastructureFailureKind = "no_effect";
            current.infrastructureFailureDetails = "the bounded implementation/test contract required a leased repository change, but Harness completed with an empty diff";
        }
        if (budgetError) {
            current.status = "failed";
            current.error = budgetError;
        }
        else if (unauthorizedCommit) {
            current.status = "scope_violation";
            current.error = `worker changed Git HEAD from ${current.startingHeadCommit} to ${finalHead}; worker-created commits are forbidden`;
        }
        else if (finalUnsafeSymlinks.length) {
            current.status = "scope_violation";
            current.error = `worker created or modified symlink paths: ${finalUnsafeSymlinks.join(", ")}`;
        }
        else if (finalUnsafeGitlinks.length) {
            current.status = "scope_violation";
            current.error = `worker created or modified gitlink/submodule metadata: ${finalUnsafeGitlinks.join(", ")}`;
        }
        else if (finalStaged.length) {
            current.status = "scope_violation";
            current.error = `worker staged Git index changes: ${finalStaged.join(", ")}`;
        }
        else if (finalViolations.length) {
            current.status = "scope_violation";
            current.error = "worker modified paths outside its exclusive write leases";
        }
        else if (minimalToolPlaneFailure
            || current.infrastructureFailureKind === "minimal_tool_plane"
            || current.infrastructureFailureKind === "minimal_tool_plane_composition"
            || current.infrastructureFailureKind === "minimal_tool_serialization_mismatch") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "minimal Harness tool plane failed preflight";
        }
        else if (leakedToolProtocol || current.infrastructureFailureKind === "tool_protocol") {
            current.status = "failed";
            current.error = current.toolProtocolFailure ?? current.infrastructureFailureDetails ?? "Harness tool protocol failed before an executable tool call was dispatched";
        }
        else if (current.infrastructureFailureKind === "provider_transport") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "provider transport failed before a model response was available";
        }
        else if (current.infrastructureFailureKind === "provider_credential") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "Provider credential was unavailable to the trusted proxy";
        }
        else if (current.infrastructureFailureKind === "provider_protocol") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "Provider rejected or violated the request protocol";
        }
        else if (current.infrastructureFailureKind === "thinking_policy_state") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "attempt thinking policy changed before Provider I/O";
        }
        else if (current.infrastructureFailureKind === "thinking_replay_state") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "reasoning_content replay state was incomplete before Provider I/O";
        }
        else if (current.infrastructureFailureKind === "no_effect") {
            current.status = "failed";
            current.error = current.infrastructureFailureDetails ?? "task required a repository change but completed with an empty diff";
        }
        else if (launchError) {
            current.status = "failed";
            current.error = launchError;
        }
        else if (timedOut) {
            current.status = "failed";
            current.error = `${current.effectiveExecutor ?? current.executor} exceeded ${current.runtimeSeconds} seconds`;
        }
        else if (code !== 0) {
            current.status = "failed";
            current.error = `${current.effectiveExecutor ?? current.executor} exited with code ${code}`;
        }
        else if (finalPaths.length === 0)
            current.status = "completed_no_changes";
        else
            current.status = "completed";
        if (current.harnessMode === "minimal")
            current.minimalRequestPhase = "terminal";
    });
    await updatePlan(config, completed.planId, (plan) => {
        const leaf = plan.leaves.find((candidate) => candidate.id === completed.leafId);
        if (!leaf)
            return;
        leaf.activeTaskId = completed.id;
        leaf.completedTaskId = completed.id;
        if (completed.status === "completed" || completed.status === "completed_no_changes") {
            leaf.status = "completed";
            plan.status = "running";
        }
        else {
            leaf.status = "rejected";
            plan.status = "running";
        }
    });
    await writeUsageSnapshot(config, completed);
    try {
        const profile = await recordTaskSplitOutcome(config, completed, "execution");
        if (profile) {
            await updateTask(config, completed.id, (current) => {
                current.splitOutcomeRecordedAt = nowIso();
                current.splitOutcomeRevision = profile.revision;
            });
        }
    }
    catch (error) {
        await writeFile(completed.stderrPath, `[split-memory] ${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
    }
    if (config.monitor.enabled) {
        try {
            await persistMonitorSnapshot(config);
        }
        catch { /* task result remains authoritative */ }
    }
}
main().catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    try {
        const config = await loadConfig();
        const taskId = process.argv[2];
        if (taskId) {
            const task = await updateTask(config, taskId, (current) => {
                if (current.status === "cancelled")
                    return;
                const infrastructureFailureKind = classifyMinimalToolPlaneFailure(current, message);
                current.status = "failed";
                delete current.workerDeadObservedAt;
                current.phase = "failed";
                current.completedAt = nowIso();
                current.error = message;
                if (infrastructureFailureKind !== undefined && current.infrastructureFailureKind === undefined) {
                    current.infrastructureFailureKind = infrastructureFailureKind;
                    current.infrastructureFailureDetails = message;
                }
            });
            await updatePlan(config, task.planId, (plan) => {
                const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
                if (leaf) {
                    leaf.status = "rejected";
                    leaf.activeTaskId = task.id;
                    leaf.completedTaskId = task.id;
                }
                plan.status = "running";
            });
            try {
                await recordTaskSplitOutcome(config, task, "execution");
            }
            catch { /* primary worker failure remains authoritative */ }
        }
    }
    catch { /* preserve original failure */ }
    process.exitCode = 1;
});
//# sourceMappingURL=worker.js.map