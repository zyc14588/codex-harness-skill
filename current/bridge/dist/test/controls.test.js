import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearBudgetOverride, effectiveBudget, effectiveLlamaConfig, listBudgetControlEvents, setBudgetOverride, setBudgetPolicy, setLlamaRuntimeConfig, } from "../controls.js";
import { createTask, taskDirectory } from "../store.js";
import { testConfig } from "./test-config.js";
test("runtime budget policy and group override are bounded, auditable, and immediately effective", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-controls-test-"));
    try {
        const config = testConfig(root);
        const policy = await setBudgetPolicy(config, { maxApiCalls: 6, maxInputTokens: 50_000, maxOutputTokens: 5_000, maxCostCny: 1.2 }, { maxApiCalls: 20, maxInputTokens: 500_000, maxOutputTokens: 50_000, maxCostCny: 10 }, { maxApiCalls: 150, maxInputTokens: 5_000_000, maxOutputTokens: 600_000, maxCostCny: 500 }, "unit test policy", "dashboard");
        assert.equal(policy.budgetPolicy.defaultHarnessBudget.maxCostCny, 1.2);
        assert.equal(policy.budgetPolicy.maximumHarnessBudget.maxCostCny, 10);
        assert.equal(policy.budgetPolicy.defaultProComplexBudget.enforcement, "hard");
        assert.equal(policy.budgetPolicy.defaultProComplexBudget.ceilingPolicy, "unbounded");
        assert.equal(policy.budgetPolicy.maximumHarnessBudget.enforcement, "hard");
        const referenceOnly = await setBudgetPolicy(config, policy.budgetPolicy.defaultHarnessBudget, { ...policy.budgetPolicy.maximumHarnessBudget, maxApiCalls: 1_000_000, maxCostCny: 100_000 }, policy.budgetPolicy.defaultProComplexBudget, "reference thresholds may exceed installation references", "dashboard");
        assert.equal(referenceOnly.budgetPolicy.maximumHarnessBudget.maxCostCny, 100_000);
        await assert.rejects(() => setBudgetPolicy(config, policy.budgetPolicy.defaultHarnessBudget, { ...policy.budgetPolicy.maximumHarnessBudget, maxInputTokens: config.controller.maximumHarnessBudget.maxInputTokens + 1 }, policy.budgetPolicy.defaultProComplexBudget, "token gate too high", "dashboard"), /operator ceiling/);
        const frozen = config.controller.defaultHarnessBudget;
        const dir = taskDirectory(config, "task-a");
        const task = {
            schemaVersion: 6, id: "task-a", planId: "plan-a", leafId: "leaf-a", budgetGroupId: "group-a",
            requestedExecutor: "harness", executor: "harness", effectiveExecutor: "harness", complexity: "small", mode: "implementation",
            harnessMode: "minimal", dependsOn: [], toolCapabilities: ["repository_read", "verification", "git_inspect"], taskFamily: "unit-fixture",
            splitDecision: { memorySchemaVersion: 5, memoryKey: "fixture", taskFamily: "unit-fixture", memoryRevision: 0, sampleCount: 0, ignoredLegacySampleCount: 0, confidence: 0,
                recommendedLeafScale: 1, recommendedComplexity: "small", recommendedMaxInputTokens: 180_000, recommendedMaxOutputTokens: 24_000,
                anomalyRate: 0, rationale: ["fixture"], chosenComplexity: "small", chosenMaxInputTokens: 180_000, chosenMaxOutputTokens: 24_000 },
            objective: "fixture", repoRoot: root, baseRef: "HEAD", baseCommit: "0".repeat(40), startingHeadCommit: "0".repeat(40),
            branchName: "agent/test", worktreePath: path.join(root, "worktree"), harnessWritePaths: ["out.txt"], codexWritePaths: [],
            acceptanceCriteria: ["fixture"], contextFiles: [], verificationCommands: ["true"], budget: frozen, status: "running",
            createdAt: "2026-08-19T00:00:00.000Z", runtimeSeconds: 60, promptPath: path.join(dir, "prompt.txt"),
            stdoutPath: path.join(dir, "stdout.log"), stderrPath: path.join(dir, "stderr.log"), usagePath: path.join(dir, "usage.jsonl"),
            changedPaths: [], outOfScopePaths: [],
        };
        await createTask(config, task);
        const override = await setBudgetOverride(config, "group-a", { maxApiCalls: 8, maxInputTokens: 60_000, maxOutputTokens: 6_000, maxCostCny: 2 }, "active task top-up", "dashboard");
        assert.equal((await effectiveBudget(config, frozen, "group-a")).maxApiCalls, 8);
        assert.equal(override.budget.maxCostCny, 2);
        await clearBudgetOverride(config, "group-a", "done", "dashboard");
        assert.equal((await effectiveBudget(config, frozen, "group-a")).maxApiCalls, frozen.maxApiCalls);
        const advisoryDir = taskDirectory(config, "task-pro");
        const advisoryTask = {
            ...task, id: "task-pro", leafId: "leaf-pro", budgetGroupId: "group-pro", complexity: "large", model: "deepseek-v4-pro",
            budget: config.controller.defaultProComplexBudget, promptPath: path.join(advisoryDir, "prompt.txt"), stdoutPath: path.join(advisoryDir, "stdout.log"),
            stderrPath: path.join(advisoryDir, "stderr.log"), usagePath: path.join(advisoryDir, "usage.jsonl"),
        };
        await createTask(config, advisoryTask);
        const advisoryOverride = await setBudgetOverride(config, "group-pro", {
            maxApiCalls: 1_000, maxInputTokens: 50_000_000, maxOutputTokens: 5_000_000, maxCostCny: 5_000, maxCostUsd: 500,
        }, "raise advisory target", "dashboard");
        assert.equal(advisoryOverride.budget.enforcement, "hard");
        assert.equal(advisoryOverride.budget.ceilingPolicy, "unbounded");
        assert.equal((await effectiveBudget(config, advisoryTask.budget, "group-pro")).maxApiCalls, 1_000);
        const audit = await listBudgetControlEvents(config);
        assert.equal(audit.length, 5);
        assert.deepEqual(audit.map((entry) => entry.scope), ["policy", "policy", "budget_group", "budget_group", "budget_group"]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("runtime llama.cpp control cannot replace installation-owned executables or argv", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-llama-control-test-"));
    try {
        const config = testConfig(root);
        config.llamaCpp.cliBinarySha256 = "0".repeat(64);
        await assert.rejects(() => setLlamaRuntimeConfig(config, {
            enabled: true,
            mode: "cli",
            cliBinary: "/opt/custom/llama-cli-special",
            cliArgs: ["--prompt-file", "{{PROMPT_FILE}}", "--json", "{{OUTPUT_JSON_FILE}}"],
        }, "dashboard"), /installation-owned fields: cliArgs, cliBinary/);
        const cli = await setLlamaRuntimeConfig(config, {
            enabled: true,
            mode: "cli",
            model: "operator-selected-local-model",
        }, "dashboard");
        assert.equal(cli.mode, "cli");
        assert.equal(cli.cliBinary, config.llamaCpp.cliBinary);
        assert.deepEqual(cli.cliArgs, config.llamaCpp.cliArgs);
        assert.equal((await effectiveLlamaConfig(config)).enabled, true);
        await assert.rejects(() => setLlamaRuntimeConfig(config, { fallbackModel: "other-model" }, "dashboard"), /pinned/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=controls.test.js.map