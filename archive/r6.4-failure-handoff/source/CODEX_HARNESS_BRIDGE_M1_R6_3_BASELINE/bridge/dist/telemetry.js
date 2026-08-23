import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listTasks, taskDirectory } from "./store.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists } from "./util.js";
export function usageEventId() {
    return randomUUID();
}
export function estimateTokens(value, charsPerToken) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    if (!text)
        return 0;
    return Math.max(1, Math.ceil([...text].length / Math.max(1, charsPerToken)));
}
function nonnegative(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return undefined;
    return Math.floor(value);
}
export function parseProviderUsage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const usage = value;
    const input = nonnegative(usage.input_tokens ?? usage.prompt_tokens);
    const output = nonnegative(usage.output_tokens ?? usage.completion_tokens);
    if (input === undefined || output === undefined)
        return undefined;
    const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
        ? usage.input_tokens_details
        : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
            ? usage.prompt_tokens_details
            : {};
    const cacheHit = nonnegative(usage.prompt_cache_hit_tokens ?? usage.input_cache_hit_tokens ?? details.cached_tokens) ?? 0;
    const explicitMiss = nonnegative(usage.prompt_cache_miss_tokens ?? usage.input_cache_miss_tokens);
    const cacheMiss = explicitMiss ?? Math.max(0, input - cacheHit);
    return {
        inputTokens: input,
        outputTokens: output,
        cacheHitInputTokens: Math.min(input, cacheHit),
        cacheMissInputTokens: Math.min(input, cacheMiss),
    };
}
export function pricingForModel(config, model) {
    if (!model)
        return undefined;
    if (config.monitor.pricing[model])
        return config.monitor.pricing[model];
    const lower = model.toLowerCase();
    const exactKey = Object.keys(config.monitor.pricing).find((key) => key.toLowerCase() === lower);
    return exactKey ? config.monitor.pricing[exactKey] : undefined;
}
function components(usage) {
    const hit = Math.max(0, usage.cacheHitInputTokens);
    const miss = Math.max(0, usage.cacheMissInputTokens || usage.inputTokens - hit);
    return { hit, miss, output: Math.max(0, usage.outputTokens) };
}
export function calculateCostCny(pricing, usage) {
    if (!pricing || pricing.inputCacheHitCnyPerMillion === undefined || pricing.inputCacheMissCnyPerMillion === undefined || pricing.outputCnyPerMillion === undefined)
        return undefined;
    const { hit, miss, output } = components(usage);
    return (hit * pricing.inputCacheHitCnyPerMillion +
        miss * pricing.inputCacheMissCnyPerMillion +
        output * pricing.outputCnyPerMillion) / 1_000_000;
}
export function calculateCostUsd(pricing, usage) {
    if (!pricing || pricing.inputCacheHitUsdPerMillion === undefined || pricing.inputCacheMissUsdPerMillion === undefined || pricing.outputUsdPerMillion === undefined)
        return undefined;
    const { hit, miss, output } = components(usage);
    return (hit * pricing.inputCacheHitUsdPerMillion +
        miss * pricing.inputCacheMissUsdPerMillion +
        output * pricing.outputUsdPerMillion) / 1_000_000;
}
export function emptyUsageTotals() {
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
function terminalUsageEvent(event) {
    return event.kind === "request_completed" || event.kind === "request_failed" || event.kind === "local_completion";
}
export function aggregateUsageEvents(events) {
    const totals = emptyUsageTotals();
    const seen = new Set();
    for (const event of events) {
        if (seen.has(event.id))
            continue;
        seen.add(event.id);
        if (event.kind === "request_started")
            totals.apiCalls += 1;
        if (!terminalUsageEvent(event)) {
            if (event.at && (!totals.lastEventAt || event.at > totals.lastEventAt))
                totals.lastEventAt = event.at;
            continue;
        }
        if (event.kind === "request_failed")
            totals.failedCalls += 1;
        else
            totals.completedCalls += 1;
        totals.inputTokens += event.inputTokens ?? 0;
        totals.outputTokens += event.outputTokens ?? 0;
        totals.estimatedInputTokens += event.estimatedInputTokens ?? 0;
        totals.estimatedOutputTokens += event.estimatedOutputTokens ?? 0;
        totals.cacheHitInputTokens += event.cacheHitInputTokens ?? 0;
        totals.cacheMissInputTokens += event.cacheMissInputTokens ?? 0;
        if (event.costCny === undefined && event.costUsd === undefined && event.usageSource !== "local")
            totals.unpricedCalls += 1;
        totals.costCny += event.costCny ?? 0;
        totals.costUsd += event.costUsd ?? 0;
        if (event.at && (!totals.lastEventAt || event.at > totals.lastEventAt))
            totals.lastEventAt = event.at;
    }
    totals.costCny = Number(totals.costCny.toFixed(12));
    totals.costUsd = Number(totals.costUsd.toFixed(12));
    return totals;
}
export async function appendUsageEvent(task, event) {
    await ensureDir(path.dirname(task.usagePath));
    const enriched = {
        ...event,
        at: event.at ?? nowIso(),
        taskId: task.id,
        budgetGroupId: task.budgetGroupId,
    };
    await appendFile(task.usagePath, `${JSON.stringify(enriched)}\n`, { encoding: "utf8", mode: 0o600 });
}
async function readUsageEvents(target) {
    if (!await pathExists(target))
        return [];
    const text = await readFile(target, "utf8");
    const events = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.id === "string" && typeof parsed.kind === "string")
                events.push(parsed);
        }
        catch { /* ignore a trailing partial/corrupt line */ }
    }
    return events;
}
export async function usageForBudgetGroup(config, budgetGroupId) {
    const tasks = (await listTasks(config)).filter((task) => task.budgetGroupId === budgetGroupId);
    const events = [];
    for (const task of tasks)
        events.push(...await readUsageEvents(task.usagePath));
    return aggregateUsageEvents(events);
}
function finitePositive(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function rawBudgetExceededReason(totals, budget) {
    const input = totals.inputTokens + totals.estimatedInputTokens;
    const output = totals.outputTokens + totals.estimatedOutputTokens;
    if (input > budget.maxInputTokens)
        return `input token budget exceeded: ${input} > ${budget.maxInputTokens}`;
    if (output > budget.maxOutputTokens)
        return `output token budget exceeded: ${output} > ${budget.maxOutputTokens}`;
    return undefined;
}
export function budgetAdvisoryExceededReason(totals, budget) {
    return budgetReferenceAlerts(totals, budget)[0];
}
/** R6 reference-only thresholds: visible and learnable, but never execution gates. */
export function budgetReferenceAlerts(totals, budget) {
    const alerts = [];
    if (totals.apiCalls > budget.maxApiCalls)
        alerts.push(`API call reference exceeded: ${totals.apiCalls} > ${budget.maxApiCalls}`);
    if (finitePositive(budget.maxCostCny) && totals.costCny > budget.maxCostCny + 1e-12) {
        alerts.push(`configured-price CNY reference exceeded: CN¥${totals.costCny.toFixed(9)} > CN¥${budget.maxCostCny.toFixed(9)}`);
    }
    if (finitePositive(budget.maxCostUsd) && totals.costUsd > budget.maxCostUsd + 1e-12) {
        alerts.push("hidden legacy USD reference exceeded");
    }
    return alerts;
}
export function budgetExceededReason(totals, budget) {
    return rawBudgetExceededReason(totals, budget);
}
export function projectedBudgetExceededReason(totals, budget, additionalInputTokens, additionalCostUsd, additionalOutputTokens, additionalCostCny = 0) {
    const projectedInput = totals.inputTokens + totals.estimatedInputTokens + Math.max(0, additionalInputTokens);
    const projectedOutput = totals.outputTokens + totals.estimatedOutputTokens + Math.max(0, additionalOutputTokens);
    void additionalCostCny;
    void additionalCostUsd;
    if (projectedInput > budget.maxInputTokens)
        return `next request would exceed input token budget: ${projectedInput} > ${budget.maxInputTokens}`;
    if (projectedOutput > budget.maxOutputTokens)
        return `next request would exceed output token budget: ${projectedOutput} > ${budget.maxOutputTokens}`;
    return undefined;
}
export function budgetMarkerPath(config, budgetGroupId) {
    return path.join(config.stateRoot, "budgets", `${budgetGroupId}.json`);
}
export async function markBudgetExceeded(config, task, reason, totals) {
    const marker = {
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
export async function clearBudgetMarker(config, budgetGroupId) {
    await rm(budgetMarkerPath(config, budgetGroupId), { force: true });
}
export async function readBudgetMarker(config, budgetGroupId) {
    const target = budgetMarkerPath(config, budgetGroupId);
    if (!await pathExists(target))
        return undefined;
    try {
        return JSON.parse(await readFile(target, "utf8"));
    }
    catch {
        return undefined;
    }
}
export async function writeUsageSnapshot(config, task) {
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
//# sourceMappingURL=telemetry.js.map