import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig, ControllerPlan, ProcessIdentity, TaskRecord } from "./types.js";
import { atomicWriteJson, ensureDir, pathExists, readJson, sleep } from "./util.js";
import { captureProcessIdentity, processIdentityMatches } from "./process-identity.js";

export function taskDirectory(config: BridgeConfig, taskId: string): string {
  return path.join(config.stateRoot, "tasks", taskId);
}

export function taskFile(config: BridgeConfig, taskId: string): string {
  return path.join(taskDirectory(config, taskId), "task.json");
}

export function planDirectory(config: BridgeConfig, planId: string): string {
  return path.join(config.stateRoot, "plans", planId);
}

export function planFile(config: BridgeConfig, planId: string): string {
  return path.join(planDirectory(config, planId), "plan.json");
}

export async function createTask(config: BridgeConfig, task: TaskRecord): Promise<void> {
  const target = taskFile(config, task.id);
  if (await pathExists(target)) throw new Error(`task already exists: ${task.id}`);
  await ensureDir(taskDirectory(config, task.id));
  await atomicWriteJson(target, task);
}

export async function loadTask(config: BridgeConfig, taskId: string): Promise<TaskRecord> {
  const target = taskFile(config, taskId);
  if (!await pathExists(target)) throw new Error(`task not found: ${taskId}`);
  return await readJson<TaskRecord>(target);
}

export async function saveTask(config: BridgeConfig, task: TaskRecord): Promise<void> {
  await atomicWriteJson(taskFile(config, task.id), task);
}

export async function createPlan(config: BridgeConfig, plan: ControllerPlan): Promise<void> {
  const target = planFile(config, plan.id);
  if (await pathExists(target)) throw new Error(`controller plan already exists: ${plan.id}`);
  await ensureDir(planDirectory(config, plan.id));
  await atomicWriteJson(target, plan);
}

export async function loadPlan(config: BridgeConfig, planId: string): Promise<ControllerPlan> {
  const target = planFile(config, planId);
  if (!await pathExists(target)) throw new Error(`controller plan not found: ${planId}`);
  return await readJson<ControllerPlan>(target);
}

export async function savePlan(config: BridgeConfig, plan: ControllerPlan): Promise<void> {
  await atomicWriteJson(planFile(config, plan.id), plan);
}

interface LockOwner {
  pid: number;
  acquiredAt: string;
  lockName: string;
  identity: ProcessIdentity;
}

async function reclaimableLock(lockPath: string): Promise<boolean> {
  const info = await stat(lockPath);
  const ageMs = Date.now() - info.mtimeMs;
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (owner.identity !== undefined) {
      if (await processIdentityMatches(owner.identity)) return false;
      return ageMs >= 1_000;
    }
    // A legacy PID-only record has no safe anti-reuse identity. Never let its
    // PID authorize lock ownership; reclaim it only after the conservative age.
    if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) return ageMs >= 30_000;
  } catch { /* owner may not yet exist or may be corrupt */ }
  return ageMs >= 30_000;
}

export async function withNamedLock<T>(config: BridgeConfig, lockName: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const lockRoot = path.join(config.stateRoot, "locks");
  const digest = createHash("sha256").update(lockName).digest("hex").slice(0, 24);
  const lockPath = path.join(lockRoot, `${digest}.lock`);
  const ownerPath = path.join(lockPath, "owner.json");
  await ensureDir(lockRoot);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const owner: LockOwner = {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          lockName,
          identity: await captureProcessIdentity(process.pid),
        };
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (await reclaimableLock(lockPath)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock changed while inspected */ }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring bridge lock: ${lockName}`);
      await sleep(100);
    }
  }
  try { return await fn(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

export async function updateTask(
  config: BridgeConfig,
  taskId: string,
  mutate: (task: TaskRecord) => TaskRecord | void,
): Promise<TaskRecord> {
  return await withNamedLock(config, `task:${taskId}`, 30_000, async () => {
    const task = await loadTask(config, taskId);
    const updated = mutate(task) ?? task;
    await saveTask(config, updated);
    return updated;
  });
}

export async function updatePlan(
  config: BridgeConfig,
  planId: string,
  mutate: (plan: ControllerPlan) => ControllerPlan | void,
): Promise<ControllerPlan> {
  return await withNamedLock(config, `plan:${planId}`, 30_000, async () => {
    const plan = await loadPlan(config, planId);
    const updated = mutate(plan) ?? plan;
    updated.updatedAt = new Date().toISOString();
    await savePlan(config, updated);
    return updated;
  });
}

async function listJsonDirectories<T>(root: string, filename: string): Promise<T[]> {
  if (!await pathExists(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const values: T[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name, filename);
    if (!await pathExists(target)) continue;
    try { values.push(await readJson<T>(target)); } catch { /* ignore corrupt partial state */ }
  }
  return values;
}

export async function listTasks(config: BridgeConfig): Promise<TaskRecord[]> {
  const tasks = await listJsonDirectories<TaskRecord>(path.join(config.stateRoot, "tasks"), "task.json");
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPlans(config: BridgeConfig): Promise<ControllerPlan[]> {
  const plans = await listJsonDirectories<ControllerPlan>(path.join(config.stateRoot, "plans"), "plan.json");
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function withMutationLock<T>(config: BridgeConfig, fn: () => Promise<T>): Promise<T> {
  return await withNamedLock(config, "global-mutation", 30_000, fn);
}

export async function withWorktreeLock<T>(config: BridgeConfig, worktreePath: string, fn: () => Promise<T>): Promise<T> {
  return await withNamedLock(config, `worktree:${path.resolve(worktreePath)}`, 30_000, fn);
}
