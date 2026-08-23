import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./types.js";
import { listTasks, withNamedLock } from "./store.js";
import { usageForBudgetGroup } from "./telemetry.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists } from "./util.js";
import { randomUUID } from "node:crypto";

export interface CostAdjustment {
  id: string;
  at: string;
  budgetGroupId: string;
  actor: "dashboard" | "cli";
  reason: string;
  currency?: "CNY" | "USD";
  rawCostCnyAtAdjustment?: number;
  previousManualAdjustmentCny?: number;
  beforeAdjustedCostCny?: number;
  requestedCorrectedCostCny?: number;
  deltaCny?: number;
  /** Legacy M1-R2 fields retained for append-only ledger compatibility. */
  rawCostUsdAtAdjustment?: number;
  previousManualAdjustmentUsd?: number;
  beforeAdjustedCostUsd?: number;
  requestedCorrectedCostUsd?: number;
  deltaUsd?: number;
}

export interface FxRateState {
  usdToCnyRate: number | null;
  asOf: string;
  source: string;
  updatedAt?: string;
  updatedBy: "config" | "dashboard" | "cli";
}

function monitorDirectory(config: BridgeConfig): string {
  return path.join(config.stateRoot, "monitor");
}

function adjustmentPath(config: BridgeConfig): string {
  return path.join(monitorDirectory(config), "cost-adjustments.jsonl");
}

function fxStatePath(config: BridgeConfig): string {
  return path.join(monitorDirectory(config), "fx-usd-cny.json");
}

function finiteNonnegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
  return Number(value.toFixed(12));
}

function cleanText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength || text.includes("\0")) throw new Error(`${field} must be 1-${maxLength} characters without NUL`);
  return text;
}

export async function listCostAdjustments(config: BridgeConfig, limit = 200): Promise<CostAdjustment[]> {
  const target = adjustmentPath(config);
  if (!await pathExists(target)) return [];
  const text = await readFile(target, "utf8");
  const values: CostAdjustment[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as CostAdjustment;
      if (item && typeof item.id === "string" && typeof item.budgetGroupId === "string" &&
        (typeof item.deltaCny === "number" || typeof item.deltaUsd === "number")) values.push(item);
    } catch { /* preserve the raw append-only file; ignore only an isolated corrupt/trailing record */ }
  }
  return values.slice(-Math.max(1, Math.min(limit, 5_000)));
}

export async function readFxRateState(config: BridgeConfig): Promise<FxRateState> {
  const target = fxStatePath(config);
  if (await pathExists(target)) {
    try {
      const value = JSON.parse(await readFile(target, "utf8")) as FxRateState;
      if ((value.usdToCnyRate === null || (typeof value.usdToCnyRate === "number" && Number.isFinite(value.usdToCnyRate) && value.usdToCnyRate > 0))
        && typeof value.asOf === "string" && typeof value.source === "string") return value;
    } catch { /* fall back to validated config */ }
  }
  return {
    usdToCnyRate: config.monitor.currency.usdToCnyRate,
    asOf: config.monitor.currency.fxAsOf,
    source: config.monitor.currency.fxSource,
    updatedBy: "config",
  };
}

export function usdToCny(usd: number, rate: number | null): number | null {
  if (rate === null) return null;
  return Number((usd * rate).toFixed(8));
}

export async function manualAdjustmentCnyForGroup(config: BridgeConfig, budgetGroupId: string): Promise<number> {
  const values = await listCostAdjustments(config, 5_000);
  const fx = await readFxRateState(config);
  let total = 0;
  for (const item of values) {
    if (item.budgetGroupId !== budgetGroupId) continue;
    if (typeof item.deltaCny === "number") total += item.deltaCny;
    else if (typeof item.deltaUsd === "number" && fx.usdToCnyRate !== null) total += item.deltaUsd * fx.usdToCnyRate;
  }
  return Number(total.toFixed(12));
}

export async function manualAdjustmentUsdForGroup(config: BridgeConfig, budgetGroupId: string): Promise<number> {
  const values = await listCostAdjustments(config, 5_000);
  const sum = values.filter((item) => item.budgetGroupId === budgetGroupId).reduce((total, item) => total + (item.deltaUsd ?? 0), 0);
  return Number(sum.toFixed(12));
}

async function assertTerminalGroup(config: BridgeConfig, group: string): Promise<void> {
  const tasks = (await listTasks(config)).filter((task) => task.budgetGroupId === group);
  if (!tasks.length) throw new Error(`unknown budgetGroupId: ${group}`);
  const active = tasks.filter((task) => task.status === "queued" || task.status === "running");
  if (active.length) throw new Error(`cost correction is only allowed after the budget group is terminal: ${active.map((task) => task.id).join(", ")}`);
}

export async function setCorrectedBudgetGroupCostCny(
  config: BridgeConfig,
  budgetGroupId: string,
  correctedCostCny: number,
  reason: string,
  actor: "dashboard" | "cli",
): Promise<CostAdjustment> {
  const group = cleanText(budgetGroupId, "budgetGroupId", 240);
  const corrected = finiteNonnegative(correctedCostCny, "correctedCostCny");
  const why = cleanText(reason, "reason", 1_000);
  return await withNamedLock(config, `cost-adjustment:${group}`, 30_000, async () => {
    await assertTerminalGroup(config, group);
    const usage = await usageForBudgetGroup(config, group);
    const previous = await manualAdjustmentCnyForGroup(config, group);
    const before = Number((usage.costCny + previous).toFixed(12));
    const delta = Number((corrected - before).toFixed(12));
    const adjustment: CostAdjustment = {
      id: randomUUID(), at: nowIso(), budgetGroupId: group, actor, reason: why, currency: "CNY",
      rawCostCnyAtAdjustment: usage.costCny,
      previousManualAdjustmentCny: previous,
      beforeAdjustedCostCny: before,
      requestedCorrectedCostCny: corrected,
      deltaCny: delta,
    };
    await ensureDir(monitorDirectory(config));
    await appendFile(adjustmentPath(config), `${JSON.stringify(adjustment)}\n`, { encoding: "utf8", mode: 0o600 });
    return adjustment;
  });
}

/** Legacy CLI compatibility. New dashboard code uses the CNY function above. */
export async function setCorrectedBudgetGroupCost(
  config: BridgeConfig,
  budgetGroupId: string,
  correctedCostUsd: number,
  reason: string,
  actor: "dashboard" | "cli",
): Promise<CostAdjustment> {
  const group = cleanText(budgetGroupId, "budgetGroupId", 240);
  const corrected = finiteNonnegative(correctedCostUsd, "correctedCostUsd");
  const why = cleanText(reason, "reason", 1_000);
  return await withNamedLock(config, `cost-adjustment:${group}`, 30_000, async () => {
    await assertTerminalGroup(config, group);
    const usage = await usageForBudgetGroup(config, group);
    const previous = await manualAdjustmentUsdForGroup(config, group);
    const before = Number((usage.costUsd + previous).toFixed(12));
    const delta = Number((corrected - before).toFixed(12));
    const adjustment: CostAdjustment = {
      id: randomUUID(), at: nowIso(), budgetGroupId: group, actor, reason: why, currency: "USD",
      rawCostUsdAtAdjustment: usage.costUsd,
      previousManualAdjustmentUsd: previous,
      beforeAdjustedCostUsd: before,
      requestedCorrectedCostUsd: corrected,
      deltaUsd: delta,
    };
    await ensureDir(monitorDirectory(config));
    await appendFile(adjustmentPath(config), `${JSON.stringify(adjustment)}\n`, { encoding: "utf8", mode: 0o600 });
    return adjustment;
  });
}

export async function setFxRateState(
  config: BridgeConfig,
  usdToCnyRate: number | null,
  asOf: string,
  source: string,
  actor: "dashboard" | "cli",
): Promise<FxRateState> {
  if (usdToCnyRate !== null && (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0 || usdToCnyRate > 100)) {
    throw new Error("usdToCnyRate must be null or a finite number greater than 0 and at most 100");
  }
  const next: FxRateState = {
    usdToCnyRate: usdToCnyRate === null ? null : Number(usdToCnyRate.toFixed(8)),
    asOf: cleanText(asOf, "asOf", 200),
    source: cleanText(source, "source", 500),
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  return await withNamedLock(config, "fx-usd-cny", 30_000, async () => {
    await ensureDir(monitorDirectory(config));
    await atomicWriteJson(fxStatePath(config), next);
    return next;
  });
}
