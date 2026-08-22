import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsageEvents, budgetAdvisoryExceededReason, budgetExceededReason, budgetReferenceAlerts, calculateCostCny, calculateCostUsd, estimateTokens, parseProviderUsage, projectedBudgetExceededReason, } from "../telemetry.js";
const budget = { maxApiCalls: 2, maxInputTokens: 100, maxOutputTokens: 20, maxCostCny: 0.08, maxCostUsd: 0.01 };
test("DeepSeek usage parsing preserves cache hit and miss tokens", () => {
    assert.deepEqual(parseProviderUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 60,
    }), { inputTokens: 100, outputTokens: 20, cacheHitInputTokens: 40, cacheMissInputTokens: 60 });
});
test("OpenAI-style cached token details are accepted", () => {
    assert.deepEqual(parseProviderUsage({
        input_tokens: 50,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 15 },
    }), { inputTokens: 50, outputTokens: 5, cacheHitInputTokens: 15, cacheMissInputTokens: 35 });
});
test("configured CNY and USD pricing compute cache-aware cost", () => {
    const pricing = {
        inputCacheHitCnyPerMillion: 0.02,
        inputCacheMissCnyPerMillion: 1,
        outputCnyPerMillion: 2,
        inputCacheHitUsdPerMillion: 1,
        inputCacheMissUsdPerMillion: 2,
        outputUsdPerMillion: 4,
    };
    const usage = { inputTokens: 100, outputTokens: 20, cacheHitInputTokens: 40, cacheMissInputTokens: 60 };
    assert.equal(calculateCostCny(pricing, usage), (40 * 0.02 + 60 + 40) / 1_000_000);
    assert.equal(calculateCostUsd(pricing, usage), (40 + 120 + 80) / 1_000_000);
});
test("usage aggregation deduplicates events and marks unknown prices", () => {
    const events = [
        { id: "start", kind: "request_started", usageSource: "estimated" },
        { id: "done", kind: "request_completed", usageSource: "provider", inputTokens: 10, outputTokens: 2 },
        { id: "done", kind: "request_completed", usageSource: "provider", inputTokens: 999, outputTokens: 999 },
    ];
    const totals = aggregateUsageEvents(events);
    assert.equal(totals.apiCalls, 1);
    assert.equal(totals.inputTokens, 10);
    assert.equal(totals.outputTokens, 2);
    assert.equal(totals.unpricedCalls, 1);
});
test("only input/output token totals gate execution; calls and cost are reference alerts", () => {
    const exact = aggregateUsageEvents([
        { id: "s1", kind: "request_started", usageSource: "estimated" },
        { id: "s2", kind: "request_started", usageSource: "estimated" },
        { id: "d1", kind: "request_completed", usageSource: "provider", inputTokens: 100, outputTokens: 20, costCny: 0.08, costUsd: 0.01 },
    ]);
    assert.equal(budgetExceededReason(exact, budget), undefined);
    assert.equal(budgetExceededReason({ ...exact, apiCalls: 3, costCny: 999, costUsd: 999 }, budget), undefined);
    assert.deepEqual(budgetReferenceAlerts({ ...exact, apiCalls: 3, costCny: 999, costUsd: 999 }, budget).length, 3);
    assert.match(budgetExceededReason({ ...exact, inputTokens: 101 }, budget) ?? "", /input token budget exceeded/);
    assert.match(budgetExceededReason({ ...exact, outputTokens: 21 }, budget) ?? "", /output token budget exceeded/);
});
test("projected gate reserves only input and output tokens", () => {
    const totals = aggregateUsageEvents([
        { id: "s1", kind: "request_started", usageSource: "estimated" },
        { id: "d1", kind: "request_completed", usageSource: "provider", inputTokens: 10, outputTokens: 5, costCny: 999, costUsd: 999 },
    ]);
    assert.equal(projectedBudgetExceededReason({ ...totals, apiCalls: 100 }, budget, 10, 1_000, 10, 1_000), undefined);
    assert.match(projectedBudgetExceededReason(totals, budget, 91, 0, 0, 0) ?? "", /input token budget/);
    assert.match(projectedBudgetExceededReason(totals, budget, 0, 0, 16, 0) ?? "", /output token budget/);
});
test("reference thresholds remain visible while Pro complex token gates remain hard", () => {
    const totals = aggregateUsageEvents([
        { id: "s1", kind: "request_started", usageSource: "estimated" },
        { id: "d1", kind: "request_completed", usageSource: "provider", inputTokens: 500, outputTokens: 50, costCny: 1, costUsd: 0.1 },
    ]);
    const pro = {
        gatePolicy: "input_output_tokens", ceilingPolicy: "unbounded", enforcement: "hard",
        maxApiCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 100, maxCostCny: 0.000001, maxCostUsd: 0.000001,
    };
    assert.match(budgetAdvisoryExceededReason(totals, pro) ?? "", /reference exceeded/i);
    assert.equal(budgetExceededReason(totals, pro), undefined);
    assert.match(projectedBudgetExceededReason(totals, pro, 501, 100, 0, 100) ?? "", /input token budget/);
});
test("token estimate is deterministic and never returns zero for non-empty text", () => {
    assert.equal(estimateTokens("12345", 4), 2);
    assert.equal(estimateTokens("", 4), 0);
    assert.equal(estimateTokens("x", 4), 1);
});
//# sourceMappingURL=telemetry.test.js.map