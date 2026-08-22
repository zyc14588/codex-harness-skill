import { chmod, copyFile, lstat, mkdir, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { defaultConfigPath, loadConfig, sanitizedEnvironment } from "./config.js";
import {
  assertTaskWorktreeIdentity,
  changedPaths,
  findOutOfScope,
  resolveCommit,
  stagedPaths,
  unsafeChangedGitlinkPaths,
  unsafeChangedSymlinkPaths,
} from "./git.js";
import { assertHarnessProvenance } from "./service.js";
import { loadTask, taskDirectory, updatePlan, updateTask } from "./store.js";
import { monitorBaseUrl, persistMonitorSnapshot } from "./monitor.js";
import { LlamaExecutionError, runLlamaTask } from "./llama.js";
import { effectiveBudget, effectiveLlamaConfig } from "./controls.js";
import { budgetExceededReason, budgetReferenceAlerts, readBudgetMarker, usageForBudgetGroup, writeUsageSnapshot } from "./telemetry.js";
import { recordTaskSplitOutcome } from "./split-memory.js";
import { isWithin, nowIso, pathExists, runProcess, sleep, tailText } from "./util.js";
import type { ExecutionAttempt, TaskRecord } from "./types.js";

const MAX_WORKER_LOG_BYTES = 20_000_000;


function containsToolProtocolLeak(text: string): boolean {
  return /<(?:(?:｜|\|)DSML(?:｜|\|))?(?:tool_calls|invoke|parameter)\b/iu.test(text)
    || /<｜tool[▁_ ]?calls[▁_ ]?begin｜>/iu.test(text)
    || /<(?:tool[_-]?calls?|function[_-]?calls?)\b/iu.test(text)
    || /\[Calling[ \t]+tool:[ \t]*[A-Za-z0-9_-]+[ \t]+with[ \t]+arguments:/iu.test(text)
    || /(?:^|\n)[ \t]*(?:bash|pwsh|str_replace_editor)(?:[ \t]+tool[_ -]?call)?[ \t]*:?\s*(?:\n|\{)/iu.test(text);
}

function containsExecutableMarkdownFence(text: string): boolean {
  return /```[ \t]*(?:bash|sh|shell|zsh|pwsh|powershell)\b(?:[^\r\n]*)\r?\n/iu.test(text);
}

function requiresRepositoryChange(task: TaskRecord): boolean {
  return task.harnessWritePaths.length > 0 && ["implementation", "test", "repair"].includes(task.mode);
}


async function waitForActivation(target: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pathExists(target)) return;
    await sleep(25);
  }
  throw new Error(`worker activation signal was not published: ${target}`);
}

function unsafeHarnessEnvironmentNames(text: string): string[] {
  const unsafe = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match?.[1]) continue;
    const name = match[1];
    if (name.startsWith("DSH_") || ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_SEARCH_BASE_URL"].includes(name)) unsafe.add(name);
  }
  return [...unsafe].sort();
}

async function assertSafeWorkspaceEnvironment(worktreePath: string): Promise<void> {
  const target = path.join(worktreePath, ".env");
  if (!await pathExists(target)) return;
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("workspace .env must be a regular file");
  if (info.size > 1_000_000) throw new Error("workspace .env exceeds the 1000000-byte safety limit");
  const unsafe = unsafeHarnessEnvironmentNames(await readFile(target, "utf8"));
  if (unsafe.length) throw new Error(`workspace .env controls Harness bootstrap variables and is forbidden: ${unsafe.join(", ")}`);
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) throw new Error("log writer made no progress");
    offset += bytesWritten;
  }
}

async function captureBoundedLog(
  input: Readable | null,
  target: string,
  streamName: "stdout" | "stderr",
  onLimit: (message: string) => void,
): Promise<void> {
  if (!input) return;
  const output = await open(target, "a", 0o600);
  let written = 0;
  let limited = false;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (limited) continue;
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
  } finally { await output.close(); }
}

function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

function terminateChild(child: ChildProcess): void {
  signalChildGroup(child, "SIGTERM");
  const escalation = setTimeout(() => signalChildGroup(child, "SIGKILL"), 5_000);
  escalation.unref();
  child.once("close", () => clearTimeout(escalation));
}

async function runHarness(taskId: string, forcedModel?: string): Promise<{ code: number | null; launchError?: string; timedOut: boolean }> {
  const config = await loadConfig();
  const task = await loadTask(config, taskId);
  const prompt = await readFile(task.promptPath, "utf8");
  const launcher = await assertHarnessProvenance(config);
  const profile = task.harnessMode === "minimal" ? config.harnessMinimalProfile : config.harnessProfile;
  const args = [...launcher.prefixArgs, "--profile", profile, prompt];
  const env = sanitizedEnvironment(config);
  env.CODEX_HARNESS_CONFIG = defaultConfigPath();
  env.CODEX_HARNESS_TASK_ID = task.id;
  env.CODEX_HARNESS_TOOL_CAPABILITIES = JSON.stringify(task.toolCapabilities);
  env.CODEX_HARNESS_EXECUTION_MODE = task.harnessMode;
  const selectedModel = forcedModel ?? task.model;
  if (selectedModel) env.DSH_MODEL = selectedModel;
  if (config.monitor.enabled) {
    if (!task.proxyToken) throw new Error("monitored Harness task has no proxy token");
    const proxyRoot = monitorBaseUrl(config);
    env.DEEPSEEK_BASE_URL = `${proxyRoot}/proxy/${task.proxyToken}`;
    env.DEEPSEEK_SEARCH_BASE_URL = `${proxyRoot}/blocked-search/${task.proxyToken}`;
  }
  const child = spawn(launcher.command, args, {
    cwd: task.worktreePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const outcomePromise = new Promise<{ code: number | null; error?: string }>((resolve) => {
    let settled = false;
    const finish = (value: { code: number | null; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ code: null, error: error.message }));
    child.once("close", (exitCode) => finish({ code: exitCode }));
  });
  let outputLimitError: string | undefined;
  const limitTask = (message: string): void => {
    outputLimitError ??= message;
    terminateChild(child);
  };
  const stdoutCapture = captureBoundedLog(child.stdout, task.stdoutPath, "stdout", limitTask);
  const stderrCapture = captureBoundedLog(child.stderr, task.stderrPath, "stderr", limitTask);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    let cancelledAfterSpawn = false;
    if (child.pid !== undefined) {
      const childPid = child.pid;
      await updateTask(config, taskId, (current) => {
        if (current.status === "cancelled") { cancelledAfterSpawn = true; return; }
        if (current.status !== "running") throw new Error(`worker lost task ownership in status ${current.status}`);
        current.harnessPid = childPid;
      });
    }
    if (cancelledAfterSpawn) terminateChild(child);
    timer = setTimeout(() => { timedOut = true; terminateChild(child); }, task.runtimeSeconds * 1_000);
    timer.unref();
    const outcome = await outcomePromise;
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* no residual descendants */ }
    }
    const result: { code: number | null; launchError?: string; timedOut: boolean } = { code: outcome.code, timedOut };
    const launchError = outcome.error ?? outputLimitError;
    if (launchError) result.launchError = launchError;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.all([stdoutCapture, stderrCapture]);
  }
}

function attempt(executor: "harness" | "llama_cpp", model?: string): ExecutionAttempt {
  const value: ExecutionAttempt = { executor, startedAt: nowIso() };
  if (model) value.model = model;
  return value;
}

async function finishLastAttempt(taskId: string, outcome: NonNullable<ExecutionAttempt["outcome"]>, error?: string): Promise<void> {
  const config = await loadConfig();
  await updateTask(config, taskId, (current) => {
    const attempts = current.executionAttempts ?? [];
    const latest = attempts.at(-1);
    if (!latest || latest.completedAt) return;
    latest.completedAt = nowIso();
    latest.outcome = outcome;
    if (error) latest.error = error;
    current.executionAttempts = attempts;
  });
}

interface LocalLeaseSnapshotEntry {
  relative: string;
  existed: boolean;
  backupFile?: string;
  mode?: number;
}

interface LocalLeaseSnapshot {
  schemaVersion: 1;
  taskId: string;
  capturedAt: string;
  entries: LocalLeaseSnapshotEntry[];
}

function localSnapshotRoot(config: Awaited<ReturnType<typeof loadConfig>>, task: TaskRecord): string {
  return path.join(taskDirectory(config, task.id), "local-lease-baseline");
}

async function snapshotLocalLeases(config: Awaited<ReturnType<typeof loadConfig>>, task: TaskRecord): Promise<LocalLeaseSnapshot> {
  const root = localSnapshotRoot(config, task);
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "files"), { recursive: true, mode: 0o700 });
  const entries: LocalLeaseSnapshotEntry[] = [];
  for (const [index, rawRelative] of task.harnessWritePaths.entries()) {
    if (rawRelative === "**" || rawRelative.endsWith("/**")) throw new Error("llama.cpp fallback requires exact output leases");
    const relative = rawRelative.replace(/\\/g, "/");
    const target = path.resolve(task.worktreePath, relative);
    if (!isWithin(target, task.worktreePath)) throw new Error(`local snapshot path escapes worktree: ${relative}`);
    if (!await pathExists(target)) {
      entries.push({ relative, existed: false });
      continue;
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`llama.cpp output baseline must be a regular file: ${relative}`);
    const backupFile = path.join("files", `${String(index).padStart(4, "0")}.bin`);
    await copyFile(target, path.join(root, backupFile));
    await chmod(path.join(root, backupFile), 0o600);
    entries.push({ relative, existed: true, backupFile, mode: info.mode & 0o777 });
  }
  const snapshot: LocalLeaseSnapshot = { schemaVersion: 1, taskId: task.id, capturedAt: nowIso(), entries };
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return snapshot;
}

async function restoreLocalLeases(config: Awaited<ReturnType<typeof loadConfig>>, task: TaskRecord, snapshot: LocalLeaseSnapshot): Promise<void> {
  if (snapshot.taskId !== task.id) throw new Error("llama.cpp fallback snapshot task identity mismatch");
  const root = localSnapshotRoot(config, task);
  for (const entry of snapshot.entries) {
    const target = path.resolve(task.worktreePath, entry.relative);
    if (!isWithin(target, task.worktreePath)) throw new Error(`fallback restore path escapes worktree: ${entry.relative}`);
    if (!entry.existed) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    if (!entry.backupFile) throw new Error(`fallback snapshot is missing backup identity: ${entry.relative}`);
    const backup = path.resolve(root, entry.backupFile);
    if (!isWithin(backup, root)) throw new Error(`fallback snapshot backup escapes state root: ${entry.relative}`);
    const backupInfo = await lstat(backup);
    if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) throw new Error(`fallback snapshot backup is unsafe: ${entry.relative}`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const temporary = `${target}.codex-harness-restore-${process.pid}.tmp`;
    try {
      await copyFile(backup, temporary);
      await chmod(temporary, entry.mode ?? 0o600);
      await rm(target, { recursive: true, force: true });
      await (await import("node:fs/promises")).rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
}

async function assertFallbackSafeAndRestore(
  config: Awaited<ReturnType<typeof loadConfig>>,
  task: TaskRecord,
  snapshot: LocalLeaseSnapshot,
): Promise<void> {
  await assertTaskWorktreeIdentity(task);
  const head = await resolveCommit(task.worktreePath, "HEAD");
  if (head !== task.startingHeadCommit) throw new Error("llama.cpp fallback refused because the local executable changed Git HEAD");
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

async function main(): Promise<void> {
  const taskId = process.argv[2];
  const activationPath = process.argv[3];
  const readyPath = process.argv[4];
  if (!taskId || !activationPath || !readyPath) throw new Error("worker requires task id, activation path, and readiness path");
  await waitForActivation(activationPath);
  const config = await loadConfig();
  const task = await updateTask(config, taskId, (current) => {
    if (current.status === "cancelled") return;
    if (current.status !== "queued") throw new Error(`worker cannot start task in status ${current.status}`);
    current.status = "running";
    current.phase = current.mode === "repair" ? current.phase ?? "repair" : "execution";
    current.startedAt = nowIso();
    current.workerPid = process.pid;
    delete current.workerDeadObservedAt;
    current.effectiveExecutor = current.executor;
    current.executionAttempts = [attempt(current.executor, current.model)];
  });
  if (task.status === "cancelled") return;
  await writeFile(readyPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  await assertTaskWorktreeIdentity(task);
  const actualStartingHead = await resolveCommit(task.worktreePath, "HEAD");
  if (actualStartingHead !== task.startingHeadCommit) throw new Error(`worker expected HEAD ${task.startingHeadCommit}, got ${actualStartingHead}`);
  await assertSafeWorkspaceEnvironment(task.worktreePath);

  let code: number | null = null;
  let launchError: string | undefined;
  let timedOut = false;
  if (task.executor === "harness") {
    const result = await runHarness(taskId);
    code = result.code;
    timedOut = result.timedOut;
    launchError = result.launchError;
    await finishLastAttempt(taskId, timedOut ? "timed_out" : code === 0 ? "completed" : "failed", launchError);
  } else {
    const localBaseline = await snapshotLocalLeases(config, task);
    try {
      const result = await runLlamaTask(config, task);
      await writeFile(task.stdoutPath, `${result.summary}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
      code = 0;
      await finishLastAttempt(taskId, "completed");
    } catch (error) {
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
            if (current.status !== "running") throw new Error(`fallback lost task ownership in status ${current.status}`);
            current.fallbackUsed = true;
            current.fallbackReason = selected.message;
            current.fallbackModel = llama.fallbackModel;
            current.effectiveExecutor = "harness";
            current.phase = "fallback-harness";
            current.executionAttempts = [...(current.executionAttempts ?? []), attempt("harness", llama.fallbackModel)];
          });
          await writeFile(task.stderrPath, `[fallback] switching to Harness model ${llama.fallbackModel}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
          const result = await runHarness(taskId, llama.fallbackModel);
          code = result.code;
          timedOut = result.timedOut;
          launchError = result.launchError;
          await finishLastAttempt(taskId, timedOut ? "timed_out" : code === 0 ? "completed" : "failed", launchError);
        } catch (fallbackError) {
          code = 1;
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          launchError = `llama.cpp failed (${selected.message}); Harness fallback failed (${message})`;
          await writeFile(task.stderrPath, `${launchError}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
          await finishLastAttempt(taskId, "failed", message);
        }
      } else {
        code = 1;
        launchError = selected.message;
      }
    }
  }

  const latest = await loadTask(config, taskId);
  if (latest.status === "cancelled") return;
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
  const minimalToolPlaneFailure = latest.executor === "harness"
    && latest.harnessMode === "minimal"
    && /MINIMAL_TOOL_PLANE:/u.test(errorSummary);
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
    if (current.status === "cancelled") return;
    if (current.status !== "running") throw new Error(`worker cannot publish completion over status ${current.status}`);
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
    if (minimalToolPlaneFailure) {
      current.infrastructureFailureKind = "minimal_tool_plane";
      current.infrastructureFailureDetails = errorSummary;
    } else if (leakedToolProtocol) {
      current.infrastructureFailureKind = "tool_protocol";
      current.infrastructureFailureDetails = "minimal Harness emitted executable DSML, textual tool-call markup, or Markdown shell text instead of dispatching a structured tool call, and produced no repository diff";
      current.toolProtocolFailure = current.toolProtocolFailure ?? current.infrastructureFailureDetails;
      current.toolProtocolFailureAt = current.toolProtocolFailureAt ?? nowIso();
    } else if (requiredChangeMissing && current.infrastructureFailureKind === undefined) {
      current.infrastructureFailureKind = "no_effect";
      current.infrastructureFailureDetails = "the bounded implementation/test contract required a leased repository change, but Harness completed with an empty diff";
    }
    if (budgetError) {
      current.status = "failed";
      current.error = budgetError;
    } else if (unauthorizedCommit) {
      current.status = "scope_violation";
      current.error = `worker changed Git HEAD from ${current.startingHeadCommit} to ${finalHead}; worker-created commits are forbidden`;
    } else if (finalUnsafeSymlinks.length) {
      current.status = "scope_violation";
      current.error = `worker created or modified symlink paths: ${finalUnsafeSymlinks.join(", ")}`;
    } else if (finalUnsafeGitlinks.length) {
      current.status = "scope_violation";
      current.error = `worker created or modified gitlink/submodule metadata: ${finalUnsafeGitlinks.join(", ")}`;
    } else if (finalStaged.length) {
      current.status = "scope_violation";
      current.error = `worker staged Git index changes: ${finalStaged.join(", ")}`;
    } else if (finalViolations.length) {
      current.status = "scope_violation";
      current.error = "worker modified paths outside its exclusive write leases";
    } else if (minimalToolPlaneFailure || current.infrastructureFailureKind === "minimal_tool_plane") {
      current.status = "failed";
      current.error = current.infrastructureFailureDetails ?? "minimal Harness tool plane failed preflight";
    } else if (leakedToolProtocol || current.infrastructureFailureKind === "tool_protocol") {
      current.status = "failed";
      current.error = current.toolProtocolFailure ?? current.infrastructureFailureDetails ?? "Harness tool protocol failed before an executable tool call was dispatched";
    } else if (current.infrastructureFailureKind === "provider_transport") {
      current.status = "failed";
      current.error = current.infrastructureFailureDetails ?? "provider transport failed before a model response was available";
    } else if (current.infrastructureFailureKind === "no_effect") {
      current.status = "failed";
      current.error = current.infrastructureFailureDetails ?? "task required a repository change but completed with an empty diff";
    } else if (launchError) {
      current.status = "failed";
      current.error = launchError;
    } else if (timedOut) {
      current.status = "failed";
      current.error = `${current.effectiveExecutor ?? current.executor} exceeded ${current.runtimeSeconds} seconds`;
    } else if (code !== 0) {
      current.status = "failed";
      current.error = `${current.effectiveExecutor ?? current.executor} exited with code ${code}`;
    } else if (finalPaths.length === 0) current.status = "completed_no_changes";
    else current.status = "completed";
  });
  await updatePlan(config, completed.planId, (plan) => {
    const leaf = plan.leaves.find((candidate) => candidate.id === completed.leafId);
    if (!leaf) return;
    leaf.activeTaskId = completed.id;
    leaf.completedTaskId = completed.id;
    if (completed.status === "completed" || completed.status === "completed_no_changes") {
      leaf.status = "completed";
      plan.status = "running";
    } else {
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
  } catch (error) {
    await writeFile(completed.stderrPath, `[split-memory] ${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  }
  if (config.monitor.enabled) {
    try { await persistMonitorSnapshot(config); } catch { /* task result remains authoritative */ }
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  try {
    const config = await loadConfig();
    const taskId = process.argv[2];
    if (taskId) {
      const task = await updateTask(config, taskId, (current) => {
        if (current.status === "cancelled") return;
        current.status = "failed";
        delete current.workerDeadObservedAt;
        current.phase = "failed";
        current.completedAt = nowIso();
        current.error = message;
      });
      await updatePlan(config, task.planId, (plan) => {
        const leaf = plan.leaves.find((candidate) => candidate.id === task.leafId);
        if (leaf) { leaf.status = "rejected"; leaf.activeTaskId = task.id; leaf.completedTaskId = task.id; }
        plan.status = "running";
      });
      try { await recordTaskSplitOutcome(config, task, "execution"); } catch { /* primary worker failure remains authoritative */ }
    }
  } catch { /* preserve original failure */ }
  process.exitCode = 1;
});
