import { randomBytes } from "node:crypto";
import { appendFile, lstat, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig, ProcessIdentity, ProgressiveToolCapability, TaskRecord } from "./types.js";
import { brokeredToolProcessRegistry } from "./brokered-tool-registry.js";
import { findOutOfScope } from "./git.js";
import { sha256Executable } from "./process-identity.js";
import { assertControlledResourceProfile, directoryAllocatedBytes, resourceWrappedCommand } from "./resource-controls.js";
import { loadTask, taskDirectory, withNamedLock } from "./store.js";
import {
  atomicWriteJson,
  boundedText,
  ensureDir,
  isWithin,
  normalizeRepoRelative,
  nowIso,
  pathExists,
  runProcess,
  sleep,
} from "./util.js";

interface BrokeredToolState {
  schemaVersion: 1;
  taskId: string;
  enabled: ProgressiveToolCapability[];
  updatedAt: string;
}

const CAPABILITY_TOOLS: Record<ProgressiveToolCapability, string[]> = {
  repository_read: ["repo_read_file", "repo_search"],
  verification: ["run_verification"],
  git_inspect: ["git_status", "git_diff"],
};

const TOOL_CAPABILITY = new Map<string, ProgressiveToolCapability>(
  Object.entries(CAPABILITY_TOOLS).flatMap(([capability, tools]) => (
    tools.map((tool) => [tool, capability as ProgressiveToolCapability] as const)
  )),
);

function statePath(config: BridgeConfig, task: TaskRecord): string {
  return path.join(taskDirectory(config, task.id), "brokered-tools.json");
}

function auditPath(config: BridgeConfig, task: TaskRecord): string {
  return path.join(taskDirectory(config, task.id), "brokered-tools-audit.ndjson");
}

async function readState(config: BridgeConfig, task: TaskRecord): Promise<BrokeredToolState> {
  const target = statePath(config, task);
  if (!await pathExists(target)) return { schemaVersion: 1, taskId: task.id, enabled: [], updatedAt: nowIso() };
  const raw = JSON.parse(await readFile(target, "utf8")) as Partial<BrokeredToolState>;
  const enabled = Array.isArray(raw.enabled)
    ? raw.enabled.filter((value): value is ProgressiveToolCapability => (
        value === "repository_read" || value === "verification" || value === "git_inspect"
      ))
    : [];
  return { schemaVersion: 1, taskId: task.id, enabled: [...new Set(enabled)], updatedAt: raw.updatedAt ?? nowIso() };
}

async function audit(config: BridgeConfig, task: TaskRecord, attemptId: string, tool: string, result: "completed" | "failed", reason?: string): Promise<void> {
  await ensureDir(taskDirectory(config, task.id));
  await appendFile(auditPath(config, task), `${JSON.stringify({
    schemaVersion: 1,
    at: nowIso(),
    taskId: task.id,
    attemptId,
    tool,
    result,
    ...(reason === undefined ? {} : { reason: reason.slice(0, 2_000) }),
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertActiveMinimalTask(task: TaskRecord): void {
  if (task.status !== "queued" && task.status !== "running") throw new Error(`task is not active: ${task.status}`);
  if ((task.effectiveExecutor ?? task.executor) !== "harness" || task.harnessMode !== "minimal") {
    throw new Error("brokered tools require an active minimal Harness task");
  }
}

function assertAttempt(task: TaskRecord, attemptId: string): void {
  assertActiveMinimalTask(task);
  const attempt = task.executionAttempts?.at(-1);
  if (attempt?.id !== attemptId || attempt.completedAt !== undefined || attempt.executor !== "harness") {
    throw new Error("brokered tool attempt is no longer active");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(`brokered tool request aborted: ${String(signal.reason ?? "aborted")}`);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as Record<string, unknown>;
}

function stringArg(input: Record<string, unknown>, name: string, max = 64_000): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return boundedText(value, name, max);
}

function optionalInteger(input: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

export const MODEL_VISIBLE_TEXT_MAX_BYTES = 49_152;
export const MODEL_VISIBLE_ESTIMATED_TOKEN_MAX = 12_288;

export interface ModelVisibleTextPage {
  text: string;
  truncation: {
    encoding: "utf-8";
    sourceBytes: number;
    requestedOffsetBytes: number;
    offsetBytes: number;
    returnedBytes: number;
    estimatedTokens: number;
    maxBytes: number;
    maxEstimatedTokens: number;
    truncated: boolean;
    hasPrevious: boolean;
    nextOffsetBytes: number | null;
  };
}

/** Byte-accurate, UTF-8-safe model output page with explicit token estimation. */
export function modelVisibleTextPage(text: string, requestedOffsetBytes = 0, requestedMaxBytes = MODEL_VISIBLE_TEXT_MAX_BYTES): ModelVisibleTextPage {
  if (!Number.isSafeInteger(requestedOffsetBytes) || requestedOffsetBytes < 0) throw new Error("offset_bytes must be a non-negative integer");
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 256 || requestedMaxBytes > MODEL_VISIBLE_TEXT_MAX_BYTES) {
    throw new Error(`max_bytes must be an integer from 256 to ${MODEL_VISIBLE_TEXT_MAX_BYTES}`);
  }
  const source = Buffer.from(text, "utf8");
  let start = Math.min(requestedOffsetBytes, source.length);
  while (start < source.length && (source[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(source.length, start + requestedMaxBytes);
  while (end > start && end < source.length && (source[end]! & 0xc0) === 0x80) end -= 1;
  const selected = source.subarray(start, end);
  const returned = selected.toString("utf8");
  const returnedBytes = selected.length;
  return {
    text: returned,
    truncation: {
      encoding: "utf-8",
      sourceBytes: source.length,
      requestedOffsetBytes,
      offsetBytes: start,
      returnedBytes,
      estimatedTokens: Math.ceil(returnedBytes / 4),
      maxBytes: requestedMaxBytes,
      maxEstimatedTokens: Math.ceil(requestedMaxBytes / 4),
      truncated: start > 0 || end < source.length,
      hasPrevious: start > 0,
      nextOffsetBytes: end < source.length ? end : null,
    },
  };
}

function requestedModelPage(input: Record<string, unknown>, text: string): ModelVisibleTextPage {
  return modelVisibleTextPage(
    text,
    optionalInteger(input, "offset_bytes", 0, 0, 5_000_000),
    optionalInteger(input, "max_bytes", MODEL_VISIBLE_TEXT_MAX_BYTES, 256, MODEL_VISIBLE_TEXT_MAX_BYTES),
  );
}

async function gitCommonDirectory(worktree: string, signal: AbortSignal): Promise<string> {
  const result = await runProcess("/usr/bin/git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeoutMs: 10_000,
    maxCaptureChars: 16_000,
    signal,
  });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`cannot resolve tool Git common directory: ${result.stderr.trim()}`);
  return await realpath(result.stdout.trim());
}

function destinationDirectories(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const item of paths) {
    let current = path.resolve(item);
    while (current !== "/") {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

async function isolatedCommand(
  config: BridgeConfig,
  task: TaskRecord,
  command: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  onProcessIdentity: (identity: ProcessIdentity) => void | Promise<void>,
  maxCaptureChars = 500_000,
): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  await assertControlledResourceProfile(config);
  const bwrap = await sha256Executable(config.harnessIsolation.bubblewrapBinary);
  if (bwrap.sha256 !== config.harnessIsolation.bubblewrapSha256) throw new Error(`Bubblewrap SHA-256 mismatch for ${bwrap.realpath}`);
  const worktree = await realpath(task.worktreePath);
  const gitCommon = await gitCommonDirectory(worktree, signal);
  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = path.dirname(path.dirname(nodeExecutable));
  const mountNodeRoot = !isWithin(nodeRoot, "/usr");
  const bindDestinations = ["/usr", worktree, gitCommon, ...(mountNodeRoot ? [nodeRoot] : [])];
  const sandboxArgs: string[] = [
    "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    "--cap-drop", "ALL", "--clearenv", "--hostname", "codex-harness-tool",
  ];
  for (const directory of destinationDirectories(bindDestinations)) sandboxArgs.push("--dir", directory);
  sandboxArgs.push(
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", worktree, worktree,
    "--ro-bind", gitCommon, gitCommon,
  );
  if (mountNodeRoot) sandboxArgs.push("--ro-bind", nodeRoot, nodeRoot);
  sandboxArgs.push(
    "--setenv", "PATH", `${path.dirname(nodeExecutable)}:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "HOME", "/tmp",
    "--setenv", "USER", "codex-harness-tool",
    "--setenv", "LOGNAME", "codex-harness-tool",
    "--setenv", "SHELL", "/bin/sh",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "NO_COLOR", "1",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "GIT_OPTIONAL_LOCKS", "0",
    "--setenv", "GIT_TERMINAL_PROMPT", "0",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
    "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
    "--chdir", worktree,
    "--", command, ...args,
  );
  const profile = config.harnessIsolation.resourceProfile;
  const initialBytes = await directoryAllocatedBytes(worktree);
  if (initialBytes > profile.worktreeMaxBytes) {
    throw new Error(`task worktree already exceeds ${profile.worktreeMaxBytes} byte resource ceiling`);
  }
  const quotaController = new AbortController();
  const commandSignal = AbortSignal.any([signal, quotaController.signal]);
  let stopQuotaWatch = false;
  let quotaFailure: string | undefined;
  const quotaWatch = (async () => {
    while (!stopQuotaWatch && !commandSignal.aborted) {
      const bytes = await directoryAllocatedBytes(worktree);
      if (bytes > profile.worktreeMaxBytes) {
        quotaFailure = `task worktree exceeded ${profile.worktreeMaxBytes} byte resource ceiling (${bytes})`;
        quotaController.abort(quotaFailure);
        return;
      }
      await sleep(250);
    }
  })();
  const wrapped = await resourceWrappedCommand(config, `tool-${task.id}`, bwrap.realpath, sandboxArgs);
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(wrapped.command, wrapped.args, {
      cwd: worktree,
      env: wrapped.env,
      timeoutMs: Math.min(timeoutMs, profile.commandTimeoutSeconds * 1_000),
      maxCaptureChars,
      killProcessGroup: true,
      signal: commandSignal,
      abortGraceMs: 1_000,
      onProcessIdentity,
    });
  } finally {
    stopQuotaWatch = true;
    await quotaWatch;
  }
  if (quotaFailure) throw new Error(quotaFailure);
  if (result.aborted || signal.aborted) throw new Error(`brokered tool process aborted: ${String(signal.reason ?? "aborted")}`);
  return {
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

async function resolveToolPath(task: TaskRecord, raw: string, mutation: boolean): Promise<{ root: string; relative: string; absolute: string }> {
  const root = await realpath(task.worktreePath);
  const relative = normalizeRepoRelative(path.isAbsolute(raw) ? path.relative(root, raw) : raw);
  if (mutation && findOutOfScope([relative], task.harnessWritePaths).length > 0) {
    throw new Error(`editor path is outside the frozen write lease: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  if (!isWithin(absolute, root)) throw new Error(`path escapes worktree: ${relative}`);
  return { root, relative, absolute };
}

async function atomicTextWrite(target: string, text: string, mode = 0o600): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { encoding: "utf8", mode, flag: "wx" });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function editor(task: TaskRecord, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = stringArg(input, "command", 32);
  const mutation = command !== "view";
  const target = await resolveToolPath(task, stringArg(input, "path", 4_096), mutation);
  if (command === "view") {
    const info = await lstat(target.absolute);
    if (info.isSymbolicLink()) throw new Error("editor refuses symbolic links");
    if (info.isDirectory()) {
      const entries = (await readdir(target.absolute, { withFileTypes: true })).slice(0, 1_000);
      const page = requestedModelPage(input, entries.map((entry) => JSON.stringify(`${entry.isDirectory() ? "d" : "f"} ${entry.name}`)).join("\n"));
      return { path: target.relative, kind: "directory", totalEntries: entries.length, text: page.text, truncation: page.truncation };
    }
    if (!info.isFile() || info.size > 5_000_000) throw new Error("editor view requires a regular file no larger than 5 MB");
    const canonical = await realpath(target.absolute);
    if (!isWithin(canonical, target.root)) throw new Error("editor path resolves outside the worktree");
    const text = await readFile(canonical, "utf8");
    if (text.includes("\0")) throw new Error("editor refuses binary/NUL files");
    const lines = text.split(/\r?\n/u);
    const range = input.view_range;
    const start = Array.isArray(range) && Number.isSafeInteger(range[0]) ? Math.max(1, Number(range[0])) : 1;
    const rawEnd = Array.isArray(range) && Number.isSafeInteger(range[1]) ? Number(range[1]) : Math.min(lines.length, start + 399);
    const end = rawEnd === -1 ? lines.length : Math.min(lines.length, Math.max(start, rawEnd));
    const page = requestedModelPage(input, lines.slice(start - 1, end).join("\n"));
    return { path: target.relative, startLine: start, endLine: end, totalLines: lines.length, text: page.text, truncation: page.truncation };
  }
  const parent = await realpath(path.dirname(target.absolute));
  if (!isWithin(parent, target.root)) throw new Error("editor parent resolves outside the worktree");
  if (command === "create") {
    if (await pathExists(target.absolute)) throw new Error(`editor create refuses existing path: ${target.relative}`);
    const text = stringArg(input, "file_text", 5_000_000);
    await atomicTextWrite(target.absolute, text);
    return { path: target.relative, command, bytes: Buffer.byteLength(text) };
  }
  const info = await lstat(target.absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) throw new Error("editor mutation requires a regular file no larger than 5 MB");
  const canonical = await realpath(target.absolute);
  if (!isWithin(canonical, target.root)) throw new Error("editor mutation resolves outside the worktree");
  const before = await readFile(canonical, "utf8");
  if (before.includes("\0")) throw new Error("editor refuses binary/NUL files");
  let after: string;
  if (command === "str_replace") {
    const oldText = stringArg(input, "old_str", 5_000_000);
    const newText = typeof input.new_str === "string" ? input.new_str : "";
    if (newText.length > 5_000_000) throw new Error("new_str exceeds 5000000 characters");
    const first = before.indexOf(oldText);
    if (first < 0 || before.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_str must match exactly once");
    after = before.slice(0, first) + newText + before.slice(first + oldText.length);
  } else if (command === "insert") {
    const line = optionalInteger(input, "insert_line", -1, 0, 10_000_000);
    const addition = stringArg(input, "new_str", 5_000_000);
    const lines = before.split("\n");
    if (line > lines.length) throw new Error(`insert_line exceeds file line count: ${line} > ${lines.length}`);
    lines.splice(line, 0, addition);
    after = lines.join("\n");
  } else {
    throw new Error(`unsupported editor command: ${command}`);
  }
  await atomicTextWrite(canonical, after, info.mode & 0o777);
  return { path: target.relative, command, bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after) };
}

function capabilityArg(input: Record<string, unknown>): ProgressiveToolCapability {
  const value = input.capability;
  if (value !== "repository_read" && value !== "verification" && value !== "git_inspect") {
    throw new Error("capability must be repository_read, verification, or git_inspect");
  }
  return value;
}

async function invoke(
  config: BridgeConfig,
  task: TaskRecord,
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  onProcessIdentity: (identity: ProcessIdentity) => void | Promise<void>,
): Promise<unknown> {
  throwIfAborted(signal);
  if (tool === "capability_catalog") {
    const state = await readState(config, task);
    return {
      taskId: task.id,
      authorized: task.toolCapabilities.map((capability) => ({ capability, tools: CAPABILITY_TOOLS[capability], enabled: state.enabled.includes(capability) })),
    };
  }
  if (tool === "capability_enable") {
    const capability = capabilityArg(input);
    const reason = stringArg(input, "reason", 2_000);
    return await withNamedLock(config, `brokered-tools:${task.id}`, 30_000, async () => {
      throwIfAborted(signal);
      if (!task.toolCapabilities.includes(capability)) throw new Error(`capability is not authorized by the leaf contract: ${capability}`);
      const state = await readState(config, task);
      const changed = !state.enabled.includes(capability);
      const next = { ...state, enabled: changed ? [...state.enabled, capability] : state.enabled, updatedAt: nowIso() };
      await atomicWriteJson(statePath(config, task), next);
      return { capability, enabled: true, changed, reasonAccepted: reason.length > 0, tools: CAPABILITY_TOOLS[capability] };
    });
  }
  if (tool === "bash") {
    return await isolatedCommand(config, task, "/bin/bash", ["-lc", stringArg(input, "command")], optionalInteger(input, "timeout_seconds", 300, 1, 7_200) * 1_000, signal, onProcessIdentity);
  }
  if (tool === "pwsh") {
    return await isolatedCommand(config, task, "/usr/bin/pwsh", ["-NoLogo", "-NoProfile", "-Command", stringArg(input, "command")], optionalInteger(input, "timeout_seconds", 300, 1, 7_200) * 1_000, signal, onProcessIdentity);
  }
  if (tool === "str_replace_editor") {
    const result = await editor(task, input);
    throwIfAborted(signal);
    return result;
  }

  const capability = TOOL_CAPABILITY.get(tool);
  if (capability === undefined) throw new Error(`unknown brokered tool: ${tool}`);
  const state = await readState(config, task);
  if (!task.toolCapabilities.includes(capability) || !state.enabled.includes(capability)) {
    throw new Error(`tool is not currently disclosed: ${tool}`);
  }
  if (tool === "repo_read_file") {
    const target = await resolveToolPath(task, stringArg(input, "file_path", 4_096), false);
    const info = await lstat(target.absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) throw new Error("repo_read_file requires a regular file no larger than 5 MB");
    const canonical = await realpath(target.absolute);
    if (!isWithin(canonical, target.root)) throw new Error("repo_read_file resolves outside the worktree");
    const text = await readFile(canonical, "utf8");
    if (text.includes("\0")) throw new Error("repo_read_file refuses binary/NUL files");
    const lines = text.split(/\r?\n/u);
    const start = optionalInteger(input, "start_line", 1, 1, 10_000_000);
    const end = optionalInteger(input, "end_line", Math.min(start + 399, 10_000_000), start, Math.min(start + 1_999, 10_000_000));
    const page = requestedModelPage(input, lines.slice(start - 1, end).join("\n"));
    return {
      path: target.relative,
      startLine: start,
      endLine: Math.min(end, lines.length),
      totalLines: lines.length,
      text: page.text,
      truncation: page.truncation,
    };
  }
  if (tool === "repo_search") {
    const pattern = stringArg(input, "pattern", 1_000);
    const rawPaths = input.paths ?? [];
    if (!Array.isArray(rawPaths) || rawPaths.length > 20 || !rawPaths.every((value) => typeof value === "string")) throw new Error("paths must be a bounded string array");
    const paths = rawPaths.map((value) => normalizeRepoRelative(String(value)));
    return await isolatedCommand(config, task, "/usr/bin/git", ["grep", "-n", "--no-color", "-I", "-e", pattern, "--", ...(paths.length ? paths : ["."])], 60_000, signal, onProcessIdentity, 200_000);
  }
  if (tool === "run_verification") {
    const index = optionalInteger(input, "command_index", -1, 0, 99);
    const command = task.verificationCommands[index];
    if (command === undefined) throw new Error(`verification command index out of range: ${index}`);
    return await isolatedCommand(config, task, "/bin/bash", ["-lc", command], optionalInteger(input, "timeout_seconds", 1_800, 1, 7_200) * 1_000, signal, onProcessIdentity);
  }
  if (tool === "git_status") return await isolatedCommand(config, task, "/usr/bin/git", ["status", "--short", "--branch"], 60_000, signal, onProcessIdentity, 100_000);
  const selected = typeof input.file_path === "string" ? normalizeRepoRelative(input.file_path) : undefined;
  const args = ["diff", "--no-ext-diff", "--no-color", ...(input.stat_only === true ? ["--stat"] : []), "--", ...(selected ? [selected] : [])];
  return await isolatedCommand(config, task, "/usr/bin/git", args, 60_000, signal, onProcessIdentity, 500_000);
}

export interface BrokeredToolExecutionOptions {
  attemptId: string;
  signal: AbortSignal;
}

export async function executeBrokeredTool(
  config: BridgeConfig,
  task: TaskRecord,
  tool: string,
  rawArguments: unknown,
  options: BrokeredToolExecutionOptions,
): Promise<unknown> {
  assertAttempt(task, options.attemptId);
  if (!/^[a-z_]{1,80}$/u.test(tool)) throw new Error("tool name is invalid");
  const lease = brokeredToolProcessRegistry.open(task.id, options.attemptId, options.signal);
  try {
    const current = await loadTask(config, task.id);
    assertAttempt(current, options.attemptId);
    throwIfAborted(lease.signal);
    const result = await invoke(config, current, tool, asObject(rawArguments), lease.signal, (identity) => lease.bindProcess(identity));
    throwIfAborted(lease.signal);
    const finalTask = await loadTask(config, task.id);
    assertAttempt(finalTask, options.attemptId);
    await audit(config, finalTask, options.attemptId, tool, "completed");
    return result;
  } catch (error) {
    await audit(config, task, options.attemptId, tool, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    lease.close();
  }
}
