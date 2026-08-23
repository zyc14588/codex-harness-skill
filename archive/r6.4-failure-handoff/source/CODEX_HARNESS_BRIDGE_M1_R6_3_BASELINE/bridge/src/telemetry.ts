import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeConfig,
  BudgetMarker,
  PricingEntry,
  ProviderUsage,
  TaskBudget,
  TaskRecord,
  UsageEvent,
  UsageTotals,
} from "./types.js";
import { listTasks, taskDirectory } from "./store.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists } from "./util.js";

export function usageEventId(): string {
  return randomUUID();
}

export function estimateTokens(value: unknown, charsPerToken: number): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  return Math.max(1, Math.ceil([...text].length / Math.max(1, charsPerToken)));
}

function nonnegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function parseProviderUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const input = nonnegative(usage.input_tokens ?? usage.prompt_tokens);
  const output = nonnegative(usage.output_tokens ?? usage.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as Record<string, unknown>
    : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details as Record<string, unknown>
      : {};
  const cacheHit = nonnegative(
    usage.prompt_cache_hit_tokens ?? usage.input_cache_hit_tokens ?? details.cached_tokens,
  ) ?? 0;
  const explicitMiss = nonnegative(usage.prompt_cache_miss_tokens ?? usage.input_cache_miss_tokens);
  const cacheMiss = explicitMiss ?? Math.max(0, input - cacheHit);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheHitInputTokens: Math.min(input, cacheHit),
    cacheMissInputTokens: Math.min(input, cacheMiss),
  };
}

export function pricingForModel(config: BridgeConfig, model?: string): PricingEntry | undefined {
  if (!model) return undefined;
  if (config.monitor.pricing[model]) return config.monitor.pricing[model];
  const lower = model.toLowerCase();
  const exactKey = Object.keys(config.monitor.pricing).find((key) => key.toLowerCase() === lower);
  return exactKey ? config.monitor.pricing[exactKey] : undefined;
}

function components(usage: ProviderUsage): { hit: number; miss: number; output: number } {
  const hit = Math.max(0, usage.cacheHitInputTokens);
  const miss = Math.max(0, usage.cacheMissInputTokens || usage.inputTokens - hit);
  return { hit, miss, output: Math.max(0, usage.outputTokens) };
}

export function calculateCostCny(pricing: PricingEntry | undefined, usage: ProviderUsage): number | undefined {
  if (!pricing || pricing.inputCacheHitCnyPerMillion === undefined || pricing.inputCacheMissCnyPerMillion === undefined || pricing.outputCnyPerMillion === undefined) return undefined;
  const { hit, miss, output } = components(usage);
  return (
    hit * pricing.inputCacheHitCnyPerMillion +
    miss * pricing.inputCacheMissCnyPerMillion +
    output * pricing.outputCnyPerMillion
  ) / 1_000_000;
}

export function calculateCostUsd(pricing: PricingEntry | undefined, usage: ProviderUsage): number | undefined {
  if (!pricing || pricing.inputCacheHitUsdPerMillion === undefined || pricing.inputCacheMissUsdPerMillion === undefined || pricing.outputUsdPerMillion === undefined) return undefined;
  const { hit, miss, output } = components(usage);
  return (
    hit * pricing.inputCacheHitUsdPerMillion +
    miss * pricing.inputCacheMissUsdPerMillion +
    output * pricing.outputUsdPerMillion
  ) / 1_000_000;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    apiCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    costCny: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
}

function terminalUsageEvent(event: UsageEvent): boolean {
  return event.kind === "request_completed" || event.kind === "request_failed" || event.kind === "local_completion";
}

export function aggregateUsageEvents(events: UsageEvent[]): UsageTotals {
  const totals = emptyUsageTotals();
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.kind === "request_started") totals.apiCalls += 1;
    if (!terminalUsageEvent(event)) {
      if (event.at && (!totals.lastEventAt || event.at > totals.lastEventAt)) totals.lastEventAt = event.at;
      continue;
    }
    if (event.kind === "request_failed") totals.failedCalls += 1;
    else totals.completedCalls += 1;
    totals.inputTokens += event.inputTokens ?? 0;
    totals.outputTokens += event.outputTokens ?? 0;
    totals.estimatedInputTokens += event.estimatedInputTokens ?? 0;
    totals.estimatedOutputTokens += event.estimatedOutputTokens ?? 0;
    totals.cacheHitInputTokens += event.cacheHitInputTokens ?? 0;
    totals.cacheMissInputTokens += event.cacheMissInputTokens ?? 0;
    if (event.costCny === undefined && event.costUsd === undefined && event.usageSource !== "local") totals.unpricedCalls += 1;
    totals.costCny += event.costCny ?? 0;
    totals.costUsd += event.costUsd ?? 0;
    if (event.at && (!totals.lastEventAt || event.at > totals.lastEventAt)) totals.lastEventAt = event.at;
  }
  totals.costCny = Number(totals.costCny.toFixed(12));
  totals.costUsd = Number(totals.costUsd.toFixed(12));
  return totals;
}

export async function appendUsageEvent(task: TaskRecord, event: UsageEvent): Promise<void> {
  await ensureDir(path.dirname(task.usagePath));
  const enriched: UsageEvent = {
    ...event,
    at: event.at ?? nowIso(),
    taskId: task.id,
    budgetGroupId: task.budgetGroupId,
  };
  await appendFile(task.usagePath, `${JSON.stringify(enriched)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readUsageEvents(target: string): Promise<UsageEvent[]> {
  if (!await pathExists(target)) return [];
  const text = await readFile(target, "utf8");
  const events: UsageEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as UsageEvent;
      if (parsed && typeof parsed.id === "string" && typeof parsed.kind === "string") events.push(parsed);
    } catch { /* ignore a trailing partial/corrupt line */ }
  }
  return events;
}

export async function usageForBudgetGroup(config: BridgeConfig, budgetGroupId: string): Promise<UsageTotals> {
  const tasks = (await listTasks(config)).filter((task) => task.budgetGroupId === budgetGroupId);
  const events: UsageEvent[] = [];
  for (const task of tasks) events.push(...await readUsageEvents(task.usagePath));
  return aggregateUsageEvents(events);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rawBudgetExceededReason(totals: UsageTotals, budget: TaskBudget): string | undefined {
  const input = totals.inputTokens + totals.estimatedInputTokens;
  const output = totals.outputTokens + totals.estimatedOutputTokens;
  if (input > budget.maxInputTokens) return `input token budget exceeded: ${input} > ${budget.maxInputTokens}`;
  if (output > budget.maxOutputTokens) return `output token budget exceeded: ${output} > ${budget.maxOutputTokens}`;
  return undefined;
}

export function budgetAdvisoryExceededReason(totals: UsageTotals, budget: TaskBudget): string | undefined {
  return budgetReferenceAlerts(totals, budget)[0];
}

/** R6 reference-only thresholds: visible and learnable, but never execution gates. */
export function budgetReferenceAlerts(totals: UsageTotals, budget: TaskBudget): string[] {
  const alerts: string[] = [];
  if (totals.apiCalls > budget.maxApiCalls) alerts.push(`API call reference exceeded: ${totals.apiCalls} > ${budget.maxApiCalls}`);
  if (finitePositive(budget.maxCostCny) && totals.costCny > budget.maxCostCny + 1e-12) {
    alerts.push(`configured-price CNY reference exceeded: CN¥${totals.costCny.toFixed(9)} > CN¥${budget.maxCostCny.toFixed(9)}`);
  }
  if (finitePositive(budget.maxCostUsd) && totals.costUsd > budget.maxCostUsd + 1e-12) {
    alerts.push("hidden legacy USD reference exceeded");
  }
  return alerts;
}

export function budgetExceededReason(totals: UsageTotals, budget: TaskBudget): string | undefined {
  return rawBudgetExceededReason(totals, budget);
}

export function projectedBudgetExceededReason(
  totals: UsageTotals,
  budget: TaskBudget,
  additionalInputTokens: number,
  additionalCostUsd: number,
  additionalOutputTokens: number,
  additionalCostCny = 0,
): string | undefined {
  const projectedInput = totals.inputTokens + totals.estimatedInputTokens + Math.max(0, additionalInputTokens);
  const projectedOutput = totals.outputTokens + totals.estimatedOutputTokens + Math.max(0, additionalOutputTokens);
  void additionalCostCny;
  void additionalCostUsd;
  if (projectedInput > budget.maxInputTokens) return `next request would exceed input token budget: ${projectedInput} > ${budget.maxInputTokens}`;
  if (projectedOutput > budget.maxOutputTokens) return `next request would exceed output token budget: ${projectedOutput} > ${budget.maxOutputTokens}`;
  return undefined;
}

export function budgetMarkerPath(config: BridgeConfig, budgetGroupId: string): string {
  return path.join(config.stateRoot, "budgets", `${budgetGroupId}.json`);
}

export async function markBudgetExceeded(
  config: BridgeConfig,
  task: TaskRecord,
  reason: string,
  totals: UsageTotals,
): Promise<BudgetMarker> {
  const marker: BudgetMarker = {
    budgetGroupId: task.budgetGroupId,
    taskId: task.id,
    reason,
    at: nowIso(),
    totals,
  };
  await ensureDir(path.dirname(budgetMarkerPath(config, task.budgetGroupId)));
  await atomicWriteJson(budgetMarkerPath(config, task.budgetGroupId), marker);
  return marker;
}

export async function clearBudgetMarker(config: BridgeConfig, budgetGroupId: string): Promise<void> {
  await rm(budgetMarkerPath(config, budgetGroupId), { force: true });
}

export async function readBudgetMarker(config: BridgeConfig, budgetGroupId: string): Promise<BudgetMarker | undefined> {
  const target = budgetMarkerPath(config, budgetGroupId);
  if (!await pathExists(target)) return undefined;
  try { return JSON.parse(await readFile(target, "utf8")) as BudgetMarker; }
  catch { return undefined; }
}

export async function writeUsageSnapshot(config: BridgeConfig, task: TaskRecord): Promise<UsageTotals> {
  const totals = await usageForBudgetGroup(config, task.budgetGroupId);
  await atomicWriteJson(path.join(taskDirectory(config, task.id), "usage.snapshot.json"), {
    generatedAt: nowIso(),
    taskId: task.id,
    budgetGroupId: task.budgetGroupId,
    costSemantics: "configured_pricing_estimate_cny_primary",
    billingAuthoritative: false,
    totals,
  });
  return totals;
}
