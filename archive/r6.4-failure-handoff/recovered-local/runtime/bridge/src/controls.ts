import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeConfig,
  BudgetControlEvent,
  BudgetOverrideRecord,
  LlamaCppConfig,
  OperatorControls,
  TaskBudget,
} from "./types.js";
import { budgetWithin, normalizeLlamaConfig, normalizeTaskBudget } from "./config.js";
import { listTasks, withNamedLock } from "./store.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists, readJson, safeTaskId } from "./util.js";

function root(config: BridgeConfig): string {
  return path.join(config.stateRoot, "controls");
}

function operatorPath(config: BridgeConfig): string {
  return path.join(root(config), "operator.json");
}

function overrideRoot(config: BridgeConfig): string {
  return path.join(root(config), "budget-overrides");
}

function overridePath(config: BridgeConfig, budgetGroupId: string): string {
  return path.join(overrideRoot(config), `${safeTaskId(budgetGroupId)}.json`);
}

function auditPath(config: BridgeConfig): string {
  return path.join(root(config), "budget-control-audit.ndjson");
}

function actorText(value: string): string {
  const selected = value.trim();
  if (!selected || selected.includes("\0") || selected.length > 200) throw new Error("actor must be 1-200 characters without NUL");
  return selected;
}

function reasonText(value: string): string {
  const selected = value.trim();
  if (!selected || selected.includes("\0") || selected.length > 2_000) throw new Error("reason must be 1-2000 characters without NUL");
  return selected;
}

function initialControls(config: BridgeConfig): OperatorControls {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    updatedBy: "installation-config",
    budgetPolicy: {
      defaultHarnessBudget: { ...config.controller.defaultHarnessBudget },
      maximumHarnessBudget: { ...config.controller.maximumHarnessBudget },
      defaultProComplexBudget: { ...config.controller.defaultProComplexBudget },
    },
    llamaCpp: { ...config.llamaCpp, serverArgs: [...config.llamaCpp.serverArgs], cliArgs: [...config.llamaCpp.cliArgs] },
  };
}

function parseControls(config: BridgeConfig, value: unknown): OperatorControls {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const budgetPolicy = raw.budgetPolicy && typeof raw.budgetPolicy === "object" && !Array.isArray(raw.budgetPolicy)
    ? raw.budgetPolicy as Record<string, unknown>
    : {};
  const maximum = { ...normalizeTaskBudget(
    budgetPolicy.maximumHarnessBudget,
    config.controller.maximumHarnessBudget,
    "controls.budgetPolicy.maximumHarnessBudget",
  ), enforcement: "hard" as const };
  if (!budgetWithin(maximum, config.controller.maximumHarnessBudget)) {
    throw new Error("runtime maximum budget exceeds the installation operator ceiling");
  }
  const defaults = { ...normalizeTaskBudget(
    budgetPolicy.defaultHarnessBudget,
    config.controller.defaultHarnessBudget,
    "controls.budgetPolicy.defaultHarnessBudget",
  ), enforcement: "hard" as const };
  if (!budgetWithin(defaults, maximum)) throw new Error("runtime default budget exceeds runtime maximum budget");
  const defaultProComplexBudget = { ...normalizeTaskBudget(
    budgetPolicy.defaultProComplexBudget,
    config.controller.defaultProComplexBudget,
    "controls.budgetPolicy.defaultProComplexBudget",
  ), enforcement: "hard" as const, ceilingPolicy: "unbounded" as const };
  return {
    schemaVersion: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "unknown",
    budgetPolicy: { defaultHarnessBudget: defaults, maximumHarnessBudget: maximum, defaultProComplexBudget },
    llamaCpp: normalizeLlamaConfig(raw.llamaCpp, config.llamaCpp),
  };
}

export async function readOperatorControls(config: BridgeConfig): Promise<OperatorControls> {
  const target = operatorPath(config);
  if (!await pathExists(target)) return initialControls(config);
  return parseControls(config, await readJson<unknown>(target));
}

async function appendAudit(config: BridgeConfig, event: BudgetControlEvent): Promise<void> {
  await ensureDir(root(config));
  await appendFile(auditPath(config), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function setBudgetPolicy(
  config: BridgeConfig,
  defaultBudgetValue: unknown,
  maximumBudgetValue: unknown,
  defaultProComplexBudgetValue: unknown,
  reason: string,
  actor: string,
): Promise<OperatorControls> {
  return await withNamedLock(config, "operator-controls", 30_000, async () => {
    const before = await readOperatorControls(config);
    const maximum = { ...normalizeTaskBudget(maximumBudgetValue, before.budgetPolicy.maximumHarnessBudget, "budgetPolicy.maximumHarnessBudget"), enforcement: "hard" as const };
    if (!budgetWithin(maximum, config.controller.maximumHarnessBudget)) {
      throw new Error(`runtime maximum exceeds installation operator ceiling: ${JSON.stringify(config.controller.maximumHarnessBudget)}`);
    }
    const defaults = { ...normalizeTaskBudget(defaultBudgetValue, before.budgetPolicy.defaultHarnessBudget, "budgetPolicy.defaultHarnessBudget"), enforcement: "hard" as const };
    if (!budgetWithin(defaults, maximum)) throw new Error("defaultHarnessBudget must not exceed maximumHarnessBudget");
    const defaultProComplexBudget = { ...normalizeTaskBudget(
      defaultProComplexBudgetValue, before.budgetPolicy.defaultProComplexBudget, "budgetPolicy.defaultProComplexBudget",
    ), enforcement: "hard" as const, ceilingPolicy: "unbounded" as const };
    const next: OperatorControls = {
      ...before,
      updatedAt: nowIso(),
      updatedBy: actorText(actor),
      budgetPolicy: { defaultHarnessBudget: defaults, maximumHarnessBudget: maximum, defaultProComplexBudget },
    };
    await atomicWriteJson(operatorPath(config), next);
    await appendAudit(config, {
      id: randomUUID(), at: next.updatedAt, actor: next.updatedBy, scope: "policy",
      reason: reasonText(reason), before: before.budgetPolicy, after: next.budgetPolicy,
    });
    return next;
  });
}

export async function effectiveBudgetPolicy(config: BridgeConfig): Promise<OperatorControls["budgetPolicy"]> {
  return (await readOperatorControls(config)).budgetPolicy;
}

function parseOverride(config: BridgeConfig, value: unknown): BudgetOverrideRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid budget override");
  const raw = value as Record<string, unknown>;
  const group = safeTaskId(String(raw.budgetGroupId ?? ""));
  return {
    schemaVersion: 1,
    budgetGroupId: group,
    budget: normalizeTaskBudget(raw.budget, config.controller.defaultHarnessBudget, "budgetOverride.budget"),
    reason: typeof raw.reason === "string" ? raw.reason : "unknown",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "unknown",
  };
}

export async function readBudgetOverride(config: BridgeConfig, budgetGroupId: string): Promise<BudgetOverrideRecord | undefined> {
  const target = overridePath(config, budgetGroupId);
  if (!await pathExists(target)) return undefined;
  return parseOverride(config, await readJson<unknown>(target));
}

export async function listBudgetOverrides(config: BridgeConfig): Promise<BudgetOverrideRecord[]> {
  const directory = overrideRoot(config);
  if (!await pathExists(directory)) return [];
  const records: BudgetOverrideRecord[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { records.push(parseOverride(config, await readJson<unknown>(path.join(directory, entry.name)))); } catch { /* ignore corrupt isolated override */ }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function budgetGroupFrozenBudget(config: BridgeConfig, budgetGroupId: string): Promise<TaskBudget> {
  const task = (await listTasks(config)).find((candidate) => candidate.budgetGroupId === budgetGroupId);
  if (!task) throw new Error(`budget group has no task record: ${budgetGroupId}`);
  return task.budget;
}

export async function setBudgetOverride(
  config: BridgeConfig,
  budgetGroupId: string,
  budgetValue: unknown,
  reason: string,
  actor: string,
): Promise<BudgetOverrideRecord> {
  const group = safeTaskId(budgetGroupId);
  return await withNamedLock(config, `budget-control:${group}`, 30_000, async () => {
    const policy = await effectiveBudgetPolicy(config);
    const frozen = await budgetGroupFrozenBudget(config, group);
    const before = await readBudgetOverride(config, group);
    const requested = normalizeTaskBudget(budgetValue, before?.budget ?? frozen, "budgetOverride.budget");
    const budget = { ...requested, enforcement: "hard" as const, ceilingPolicy: frozen.ceilingPolicy ?? "operator_bounded" };
    if (budget.ceilingPolicy !== "unbounded" && !budgetWithin(budget, policy.maximumHarnessBudget)) {
      throw new Error("budget-group override exceeds current runtime maximum budget");
    }
    const record: BudgetOverrideRecord = {
      schemaVersion: 1,
      budgetGroupId: group,
      budget,
      reason: reasonText(reason),
      updatedAt: nowIso(),
      updatedBy: actorText(actor),
    };
    await atomicWriteJson(overridePath(config, group), record);
    await appendAudit(config, {
      id: randomUUID(), at: record.updatedAt, actor: record.updatedBy, scope: "budget_group",
      budgetGroupId: group, reason: record.reason, before: before?.budget ?? null, after: budget,
    });
    return record;
  });
}

export async function clearBudgetOverride(config: BridgeConfig, budgetGroupId: string, reason: string, actor: string): Promise<void> {
  const group = safeTaskId(budgetGroupId);
  await withNamedLock(config, `budget-control:${group}`, 30_000, async () => {
    const before = await readBudgetOverride(config, group);
    await rm(overridePath(config, group), { force: true });
    await appendAudit(config, {
      id: randomUUID(), at: nowIso(), actor: actorText(actor), scope: "budget_group",
      budgetGroupId: group, reason: reasonText(reason), before: before?.budget ?? null, after: null,
    });
  });
}

export async function effectiveBudget(config: BridgeConfig, frozen: TaskBudget, budgetGroupId: string): Promise<TaskBudget> {
  const policy = await effectiveBudgetPolicy(config);
  const fallback = frozen.ceilingPolicy === "unbounded" ? policy.defaultProComplexBudget : policy.defaultHarnessBudget;
  const legacyNormalized = normalizeTaskBudget(frozen, fallback, "task.budget");
  const override = await readBudgetOverride(config, budgetGroupId);
  const selected = { ...(override?.budget ?? legacyNormalized), enforcement: "hard" as const, ceilingPolicy: legacyNormalized.ceilingPolicy ?? "operator_bounded" };
  if (selected.ceilingPolicy !== "unbounded" && !budgetWithin(selected, policy.maximumHarnessBudget)) {
    throw new Error(`effective budget exceeds current operator maximum for ${budgetGroupId}`);
  }
  return selected;
}

export async function listBudgetControlEvents(config: BridgeConfig, limit = 500): Promise<BudgetControlEvent[]> {
  const target = auditPath(config);
  if (!await pathExists(target)) return [];
  const text = await readFile(target, "utf8");
  const values: BudgetControlEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as BudgetControlEvent;
      if (parsed && typeof parsed.id === "string" && typeof parsed.at === "string") values.push(parsed);
    } catch { /* ignore trailing partial line */ }
  }
  return values.slice(-Math.max(1, Math.min(limit, 5_000)));
}

export async function effectiveLlamaConfig(config: BridgeConfig): Promise<LlamaCppConfig> {
  return (await readOperatorControls(config)).llamaCpp;
}

export async function setLlamaRuntimeConfig(
  config: BridgeConfig,
  value: unknown,
  actor: string,
): Promise<LlamaCppConfig> {
  return await withNamedLock(config, "operator-controls", 30_000, async () => {
    const before = await readOperatorControls(config);
    const llamaCpp = normalizeLlamaConfig(value, before.llamaCpp);
    const next: OperatorControls = {
      ...before,
      updatedAt: nowIso(),
      updatedBy: actorText(actor),
      llamaCpp,
    };
    await atomicWriteJson(operatorPath(config), next);
    return llamaCpp;
  });
}
