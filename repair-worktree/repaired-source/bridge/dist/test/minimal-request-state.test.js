import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { armMinimalPrimaryMutation, assertMinimalRequestInvariant, buildRedactedRequestEnvelope, claimMinimalWireRequest, publishMinimalRunnerSnapshot, recordMinimalAdapterRequest, recordMinimalMutationPolicyApplication, } from "../minimal-request-state.js";
import { createTask, loadTask, taskDirectory } from "../store.js";
import { testConfig } from "./test-config.js";
function taskRecord(root, id) {
    const config = testConfig(root);
    const dir = taskDirectory(config, id);
    return {
        schemaVersion: 6,
        id,
        planId: `plan-${id}`,
        leafId: `leaf-${id}`,
        budgetGroupId: `group-${id}`,
        requestedExecutor: "harness",
        executor: "harness",
        effectiveExecutor: "harness",
        complexity: "small",
        harnessMode: "minimal",
        dependsOn: [],
        toolCapabilities: [],
        taskFamily: "minimal-request-state-test",
        splitDecision: {
            memorySchemaVersion: 4,
            memoryKey: "minimal-request-state-test",
            taskFamily: "minimal-request-state-test",
            memoryRevision: 0,
            sampleCount: 0,
            ignoredLegacySampleCount: 0,
            confidence: 0,
            recommendedLeafScale: 1,
            recommendedComplexity: "small",
            recommendedMaxInputTokens: 1_000,
            recommendedMaxOutputTokens: 500,
            anomalyRate: 0,
            rationale: ["fixture"],
            chosenComplexity: "small",
            chosenMaxInputTokens: 1_000,
            chosenMaxOutputTokens: 500,
        },
        mode: "implementation",
        objective: "write probe.json",
        repoRoot: root,
        baseRef: "HEAD",
        baseCommit: "0".repeat(40),
        startingHeadCommit: "0".repeat(40),
        branchName: `agent/${id}`,
        worktreePath: root,
        harnessWritePaths: ["probe.json"],
        codexWritePaths: [],
        acceptanceCriteria: ["probe exists"],
        contextFiles: [],
        verificationCommands: ["test -f probe.json"],
        budget: config.controller.defaultHarnessBudget,
        status: "running",
        createdAt: "2026-08-22T00:00:00.000Z",
        runtimeSeconds: 60,
        promptPath: path.join(dir, "prompt.md"),
        stdoutPath: path.join(dir, "stdout.log"),
        stderrPath: path.join(dir, "stderr.log"),
        usagePath: path.join(dir, "usage.ndjson"),
        changedPaths: [],
        outOfScopePaths: [],
        minimalRequestPhase: "booting",
    };
}
async function withStateTask(id, run) {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-minimal-state-"));
    const config = testConfig(root);
    const configPath = path.join(root, "config.json");
    const previous = process.env.CODEX_HARNESS_CONFIG;
    try {
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        process.env.CODEX_HARNESS_CONFIG = configPath;
        const task = taskRecord(root, id);
        await createTask(config, task);
        return await run(root, task);
    }
    finally {
        if (previous === undefined)
            delete process.env.CODEX_HARNESS_CONFIG;
        else
            process.env.CODEX_HARNESS_CONFIG = previous;
        await rm(root, { recursive: true, force: true });
    }
}
function requestWithTools(names) {
    return {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "secret prompt must not be persisted" }],
        tools: names.map((name) => ({
            type: "function",
            function: { name, description: "secret description", parameters: { type: "object" } },
        })),
        max_tokens: 256,
        thinking: { type: "enabled" },
    };
}
test("attributes a missing runner core tool to profile/preset composition", async () => {
    await withStateTask("composition-missing-core", async (root, task) => {
        await assert.rejects(publishMinimalRunnerSnapshot({
            taskId: task.id,
            presetId: "codex-bridge-minimal",
            visibleTools: ["mcp__bridge__capability_catalog"],
            assembledTools: ["mcp__bridge__capability_catalog"],
            requiredTools: ["bash"],
        }), /MINIMAL_TOOL_PLANE_COMPOSITION/u);
        const stored = await loadTask(testConfig(root), task.id);
        assert.equal(stored.infrastructureFailureKind, "minimal_tool_plane_composition");
        assert.equal(stored.minimalRequestPhase, "terminal");
    });
});
test("attributes a runner-present but wire-missing core tool to serialization", async () => {
    await withStateTask("serialization-wire-missing", async (_root, task) => {
        await publishMinimalRunnerSnapshot({
            taskId: task.id,
            presetId: "codex-bridge-minimal",
            visibleTools: ["bash"],
            assembledTools: ["bash"],
            requiredTools: ["bash"],
        });
        await armMinimalPrimaryMutation({ taskId: task.id });
        await recordMinimalAdapterRequest({ taskId: task.id, toolNames: ["bash"] });
        const claim = await claimMinimalWireRequest(task.id, buildRedactedRequestEnvelope("/chat/completions", requestWithTools([])));
        assert.equal(claim.ok, false);
        if (claim.ok)
            assert.fail("expected serialization mismatch");
        assert.equal(claim.kind, "minimal_tool_serialization_mismatch");
        assert.match(claim.message, /adapter input tools differ from wire tools/u);
    });
});
test("persists force telemetry before entering the simulated provider POST", async () => {
    await withStateTask("force-before-post", async (root, task) => {
        await publishMinimalRunnerSnapshot({
            taskId: task.id,
            presetId: "codex-bridge-minimal",
            visibleTools: ["bash"],
            assembledTools: ["bash"],
            requiredTools: ["bash"],
        });
        await armMinimalPrimaryMutation({ taskId: task.id });
        const adapter = await recordMinimalAdapterRequest({ taskId: task.id, toolNames: ["bash"] });
        const claim = await claimMinimalWireRequest(task.id, buildRedactedRequestEnvelope("/chat/completions", requestWithTools(["bash"])));
        assert.equal(claim.ok, true);
        await recordMinimalMutationPolicyApplication({
            taskId: task.id,
            requestOrdinal: adapter.requestOrdinal,
            toolNames: ["bash"],
            policyVersion: "test-policy",
        });
        // This load represents the first line of a provider handler: the count is
        // already durable before that handler can observe the POST.
        const providerEntryState = await loadTask(testConfig(root), task.id);
        assert.equal(providerEntryState.minimalMutationForceCount, 1);
        assert.equal(providerEntryState.minimalRequestEvidence?.[0]?.policyApplied, true);
    });
});
test("redacted wire evidence never persists prompt, token, argument, or header values", () => {
    const body = requestWithTools(["bash"]);
    body.api_key = "sk-super-secret";
    body.messages = [{ role: "user", content: "TOP_SECRET_PROMPT" }];
    body.metadata = { authorization: "Bearer TOP_SECRET_TOKEN" };
    const evidence = buildRedactedRequestEnvelope("/chat/completions?token=TOP_SECRET_QUERY", body);
    const serialized = JSON.stringify(evidence);
    assert.equal(evidence.endpoint, "/chat/completions");
    assert.deepEqual(evidence.wireToolNames, ["bash"]);
    assert.doesNotMatch(serialized, /TOP_SECRET|sk-super-secret|secret description|authorization|api_key|metadata/u);
});
test("rejects impossible force/tool-plane telemetry combinations", () => {
    assert.throws(() => assertMinimalRequestInvariant({
        infrastructureFailureKind: "minimal_tool_plane",
        minimalMutationForceCount: 0,
    }), /legacy minimal_tool_plane with zero force count/u);
    assert.throws(() => assertMinimalRequestInvariant({
        minimalMutationForceCount: 1,
        minimalMutationForcedTools: ["mcp__bridge__capability_catalog"],
    }), /without a forced core mutation tool/u);
});
//# sourceMappingURL=minimal-request-state.test.js.map