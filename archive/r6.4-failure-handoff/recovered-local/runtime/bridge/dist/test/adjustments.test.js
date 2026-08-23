import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCostAdjustments, setCorrectedBudgetGroupCostCny } from "../adjustments.js";
import { buildMonitorSnapshot } from "../monitor.js";
import { createTask, taskDirectory } from "../store.js";
import { appendUsageEvent } from "../telemetry.js";
import { testConfig } from "./test-config.js";
function task(stateRoot, status = "completed") {
    const id = "task-a";
    const dir = taskDirectory(testConfig(stateRoot), id);
    return {
        schemaVersion: 6,
        id,
        planId: "plan-a",
        leafId: "leaf-a",
        budgetGroupId: "group-a",
        requestedExecutor: "auto",
        executor: "harness",
        effectiveExecutor: "harness",
        routingReason: "test fixture",
        complexity: "small",
        harnessMode: "minimal",
        dependsOn: [],
        toolCapabilities: ["repository_read", "verification", "git_inspect"],
        taskFamily: "unit-fixture",
        splitDecision: { memorySchemaVersion: 3, memoryKey: "fixture", taskFamily: "unit-fixture", memoryRevision: 0, sampleCount: 0, ignoredLegacySampleCount: 0, confidence: 0,
            recommendedLeafScale: 1, recommendedComplexity: "small", recommendedMaxInputTokens: 1000, recommendedMaxOutputTokens: 1000,
            anomalyRate: 0, rationale: ["fixture"], chosenComplexity: "small", chosenMaxInputTokens: 1000, chosenMaxOutputTokens: 1000 },
        mode: "implementation",
        objective: "fixture",
        repoRoot: stateRoot,
        baseRef: "HEAD",
        baseCommit: "0".repeat(40),
        startingHeadCommit: "0".repeat(40),
        branchName: "agent/test",
        worktreePath: path.join(stateRoot, "worktree"),
        harnessWritePaths: ["out.txt"],
        codexWritePaths: [],
        acceptanceCriteria: ["fixture"],
        contextFiles: [],
        verificationCommands: ["true"],
        budget: { maxApiCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000, maxCostCny: 1, maxCostUsd: 1 },
        status,
        createdAt: "2026-08-18T00:00:00.000Z",
        runtimeSeconds: 60,
        promptPath: path.join(dir, "prompt.txt"),
        stdoutPath: path.join(dir, "stdout.log"),
        stderrPath: path.join(dir, "stderr.log"),
        usagePath: path.join(dir, "usage.jsonl"),
        changedPaths: [],
        outOfScopePaths: [],
    };
}
test("manual CNY cost correction is append-only and rejected while group is active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-adjustment-test-"));
    try {
        const config = testConfig(root);
        const record = task(root, "running");
        await createTask(config, record);
        await assert.rejects(() => setCorrectedBudgetGroupCostCny(config, "group-a", 0.02, "provider invoice", "cli"), /terminal/);
        record.status = "completed";
        const { saveTask } = await import("../store.js");
        await saveTask(config, record);
        await appendUsageEvent(record, { id: "start", kind: "request_started", usageSource: "estimated" });
        await appendUsageEvent(record, { id: "done", kind: "request_completed", usageSource: "provider", inputTokens: 100, outputTokens: 10, costCny: 0.01 });
        const first = await setCorrectedBudgetGroupCostCny(config, "group-a", 0.012, "provider invoice", "cli");
        assert.equal(first.deltaCny, 0.002);
        const second = await setCorrectedBudgetGroupCostCny(config, "group-a", 0.011, "bank settlement correction", "cli");
        assert.equal(second.beforeAdjustedCostCny, 0.012);
        assert.equal(second.deltaCny, -0.001);
        const ledger = await listCostAdjustments(config);
        assert.equal(ledger.length, 2);
        assert.equal(ledger[0]?.rawCostCnyAtAdjustment, 0.01);
        assert.equal(ledger[1]?.requestedCorrectedCostCny, 0.011);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("monitor snapshot is CNY-primary, live, and does not expose USD by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-snapshot-test-"));
    try {
        const config = testConfig(root);
        const record = task(root, "completed");
        await createTask(config, record);
        await appendUsageEvent(record, { id: "start", kind: "request_started", usageSource: "estimated" });
        await appendUsageEvent(record, { id: "done", kind: "request_completed", usageSource: "provider", inputTokens: 100, outputTokens: 10, costCny: 0.01 });
        await setCorrectedBudgetGroupCostCny(config, "group-a", 0.012, "invoice", "cli");
        const snapshot = await buildMonitorSnapshot(config, 100, [{
                requestId: "live", taskId: record.id, budgetGroupId: record.budgetGroupId,
                inputTokens: 50, outputTokens: 5, costCny: 0.003, costUsd: 0, updatedAt: "2026-08-18T01:00:00.000Z",
            }]);
        assert.equal(snapshot.finalizedRawCostCny, 0.01);
        assert.equal(snapshot.manualAdjustmentCny, 0.002);
        assert.equal(snapshot.liveEstimatedCostCny, 0.003);
        assert.equal(snapshot.totalCostCny, 0.015);
        assert.equal(snapshot.primaryCurrency, "CNY");
        assert.equal(snapshot.showUsd, false);
        assert.equal("totalCostUsd" in snapshot, false);
        assert.equal(snapshot.budgetUsesManualAdjustments, false);
        const rows = snapshot.tasks;
        assert.equal(rows[0]?.realtimeEstimatedCostCny, 0.015);
        assert.equal("realtimeEstimatedCostUsd" in (rows[0] ?? {}), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=adjustments.test.js.map