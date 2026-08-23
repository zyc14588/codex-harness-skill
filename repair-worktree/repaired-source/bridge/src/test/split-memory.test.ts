import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adviseSplit, recordTaskSplitOutcome, splitMemoryKey } from "../split-memory.js";
import { createTask, taskDirectory } from "../store.js";
import { appendUsageEvent } from "../telemetry.js";
import type { SplitDecisionSnapshot, TaskBudget, TaskRecord } from "../types.js";
import { testConfig } from "./test-config.js";

const budget: TaskBudget = {
  gatePolicy: "input_output_tokens",
  ceilingPolicy: "operator_bounded",
  enforcement: "hard",
  maxApiCalls: 1,
  maxInputTokens: 100,
  maxOutputTokens: 20,
  maxCostCny: 0.000001,
  maxCostUsd: 0.000001,
};

function record(root: string, id: string, family: string, decision: SplitDecisionSnapshot, status: TaskRecord["status"]): TaskRecord {
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
    complexity: "medium",
    harnessMode: "minimal",
    dependsOn: [],
    toolCapabilities: ["repository_read", "verification", "git_inspect"],
    taskFamily: family,
    splitDecision: decision,
    mode: "implementation",
    objective: "adaptive split memory fixture",
    repoRoot: root,
    baseRef: "HEAD",
    baseCommit: "0".repeat(40),
    startingHeadCommit: "0".repeat(40),
    branchName: `agent/${id}`,
    worktreePath: path.join(root, `worktree-${id}`),
    harnessWritePaths: [`${id}.txt`],
    codexWritePaths: [],
    acceptanceCriteria: ["fixture"],
    contextFiles: [],
    verificationCommands: ["true"],
    budget,
    status,
    createdAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:30.000Z",
    runtimeSeconds: 60,
    promptPath: path.join(dir, "prompt.txt"),
    stdoutPath: path.join(dir, "stdout.log"),
    stderrPath: path.join(dir, "stderr.log"),
    usagePath: path.join(dir, "usage.jsonl"),
    changedPaths: status === "completed" ? [`${id}.txt`] : [],
    outOfScopePaths: [],
  };
}

function descriptor(family: string) {
  return {
    taskFamily: family,
    requestedExecutor: "harness" as const,
    executor: "harness" as const,
    model: "deepseek-v4-flash",
    harnessMode: "minimal" as const,
    mode: "implementation" as const,
    proposedComplexity: "medium" as const,
    defaultBudget: budget,
  };
}

test("normalizes an omitted Harness model to the governed Flash split-memory tier", () => {
  const base = {
    taskFamily: "default-flash-key",
    requestedExecutor: "harness" as const,
    executor: "harness" as const,
    harnessMode: "minimal" as const,
    mode: "implementation" as const,
  };
  assert.equal(
    splitMemoryKey(base),
    splitMemoryKey({ ...base, model: "deepseek-v4-flash" }),
  );
});

test("token-gate anomaly shrinks the remembered leaf and downgrades future complexity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-memory-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const firstAdvice = await adviseSplit(config, root, descriptor("storage-migration"));
    const task = record(root, "token-overrun", "storage-migration", firstAdvice.decision, "failed");
    await createTask(config, task);
    await appendUsageEvent(task, { id: "s", kind: "request_started", usageSource: "estimated" });
    await appendUsageEvent(task, {
      id: "d",
      kind: "request_completed",
      usageSource: "provider",
      inputTokens: 150,
      outputTokens: 10,
      costCny: 999,
      costUsd: 999,
    });
    const learned = await recordTaskSplitOutcome(config, task, "execution");
    assert.equal(learned?.sampleCount, 1);
    assert.equal(learned?.tokenGateExceededCount, 1);
    assert.ok((learned?.recommendedLeafScale ?? 1) < 1);
    const next = await adviseSplit(config, root, descriptor("storage-migration"));
    assert.equal(next.decision.recommendedComplexity, "small");
    assert.ok(next.decision.recommendedLeafScale < 1);
    assert.ok(next.decision.rationale.some((item) => item.includes("token-gate")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API-call and cost reference overruns do not count as split anomalies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-reference-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const advice = await adviseSplit(config, root, descriptor("reference-only"));
    const task = record(root, "reference-overrun", "reference-only", advice.decision, "completed");
    await createTask(config, task);
    for (let index = 0; index < 5; index += 1) {
      await appendUsageEvent(task, { id: `s-${index}`, kind: "request_started", usageSource: "estimated" });
    }
    await appendUsageEvent(task, {
      id: "d",
      kind: "request_completed",
      usageSource: "provider",
      inputTokens: 40,
      outputTokens: 5,
      costCny: 999,
      costUsd: 999,
    });
    const learned = await recordTaskSplitOutcome(config, task, "execution");
    assert.equal(learned?.anomalyCount, 0);
    assert.equal(learned?.successCount, 1);
    assert.ok((learned?.recommendedLeafScale ?? 0) > 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("infrastructure failures are recorded without shrinking split advice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-infrastructure-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const proposedBudget = {
      ...budget,
      maxInputTokens: budget.maxInputTokens * 2,
      maxOutputTokens: budget.maxOutputTokens * 2,
    };
    const proposedDescriptor = {
      ...descriptor("minimal-tool-protocol"),
      defaultBudget: proposedBudget,
    };
    const initial = await adviseSplit(config, root, proposedDescriptor);
    const task = record(root, "tool-protocol", "minimal-tool-protocol", initial.decision, "failed");
    task.infrastructureFailureKind = "tool_protocol";
    task.infrastructureFailureDetails = "raw DSML was not converted to a native tool call";
    task.reviewDecision = "rejected";
    await createTask(config, task);
    await appendUsageEvent(task, { id: "infra-start", kind: "request_started", usageSource: "estimated" });
    await appendUsageEvent(task, {
      id: "infra-done",
      kind: "request_failed",
      usageSource: "provider",
      inputTokens: 2_019,
      outputTokens: 2_479,
      error: "tool protocol recovery failed",
    });
    const execution = await recordTaskSplitOutcome(config, task, "execution");
    assert.equal(execution?.sampleCount, 0);
    assert.equal(execution?.anomalyCount, 0);
    assert.equal(execution?.infrastructureFailureCount, 1);
    assert.equal(execution?.recommendedLeafScale, 1);
    assert.equal(execution?.recommendedMaxInputTokens, budget.maxInputTokens);
    assert.equal(execution?.recommendedMaxOutputTokens, budget.maxOutputTokens);
    const review = await recordTaskSplitOutcome(config, task, "review");
    assert.equal(review?.sampleCount, 0);
    assert.equal(review?.infrastructureFailureCount, 1);
    assert.equal(review?.recommendedLeafScale, 1);

    const transportTask = record(root, "provider-transport", "minimal-tool-protocol", initial.decision, "failed");
    transportTask.infrastructureFailureKind = "provider_transport";
    transportTask.infrastructureFailureDetails = "fetch failed (UND_ERR_SOCKET: other side closed)";
    await createTask(config, transportTask);
    await appendUsageEvent(transportTask, {
      id: "transport-failed",
      kind: "request_failed",
      usageSource: "estimated",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 0,
      error: transportTask.infrastructureFailureDetails,
    });
    const transport = await recordTaskSplitOutcome(config, transportTask, "execution");
    assert.equal(transport?.sampleCount, 0);
    assert.equal(transport?.anomalyCount, 0);
    assert.equal(transport?.infrastructureFailureCount, 2);
    assert.equal(transport?.recommendedLeafScale, 1);

    for (const [index, kind] of ([
      "minimal_tool_plane_composition",
      "minimal_tool_serialization_mismatch",
    ] as const).entries()) {
      const toolPlaneTask = record(root, `tool-plane-${index}`, "minimal-tool-protocol", initial.decision, "failed");
      toolPlaneTask.infrastructureFailureKind = kind;
      toolPlaneTask.infrastructureFailureDetails = `fixture ${kind}`;
      await createTask(config, toolPlaneTask);
      const learned = await recordTaskSplitOutcome(config, toolPlaneTask, "execution");
      assert.equal(learned?.sampleCount, 0);
      assert.equal(learned?.anomalyCount, 0);
      assert.equal(learned?.infrastructureFailureCount, index + 3);
      assert.equal(learned?.recommendedLeafScale, 1);
      assert.equal(learned?.recommendedMaxInputTokens, budget.maxInputTokens);
      assert.equal(learned?.recommendedMaxOutputTokens, budget.maxOutputTokens);
    }

    const next = await adviseSplit(config, root, proposedDescriptor);
    assert.equal(next.decision.sampleCount, 0);
    assert.equal(next.decision.recommendedLeafScale, 1);
    assert.equal(next.decision.recommendedMaxInputTokens, proposedBudget.maxInputTokens);
    assert.equal(next.decision.recommendedMaxOutputTokens, proposedBudget.maxOutputTokens);
    assert.ok(next.decision.rationale.some((item) => item.includes("infrastructure failure")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required-change empty diff is task-shape evidence and shrinks split advice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-no-effect-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const initial = await adviseSplit(config, root, descriptor("required-change-no-effect"));
    const task = record(root, "no-effect", "required-change-no-effect", initial.decision, "failed");
    task.infrastructureFailureKind = "no_effect";
    task.infrastructureFailureDetails = "required leased output was not produced";
    await createTask(config, task);
    await appendUsageEvent(task, {
      id: "no-effect-usage", kind: "request_completed", usageSource: "provider",
      inputTokens: 30, outputTokens: 5,
    });
    const learned = await recordTaskSplitOutcome(config, task, "execution");
    assert.equal(learned?.schemaVersion, 4);
    assert.equal(learned?.sampleCount, 1);
    assert.equal(learned?.successCount, 0);
    assert.equal(learned?.anomalyCount, 1);
    assert.equal(learned?.infrastructureFailureCount, 0);
    assert.equal(learned?.recommendedLeafScale, 0.65);
    assert.ok((learned?.recommendedMaxInputTokens ?? budget.maxInputTokens) < budget.maxInputTokens);
    assert.ok((learned?.recommendedMaxOutputTokens ?? budget.maxOutputTokens) < budget.maxOutputTokens);
    const next = await adviseSplit(config, root, descriptor("required-change-no-effect"));
    assert.equal(next.decision.sampleCount, 1);
    assert.equal(next.decision.recommendedLeafScale, 0.65);
    assert.ok(next.decision.recommendedMaxInputTokens < budget.maxInputTokens);
    assert.ok(next.decision.recommendedMaxOutputTokens < budget.maxOutputTokens);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed_no_changes is non-learnable even without an infrastructure classification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-empty-neutral-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const initial = await adviseSplit(config, root, descriptor("empty-neutral"));
    const task = record(root, "empty-neutral", "empty-neutral", initial.decision, "completed_no_changes");
    await createTask(config, task);
    await appendUsageEvent(task, {
      id: "empty-neutral-usage", kind: "request_completed", usageSource: "provider",
      inputTokens: 10, outputTokens: 2,
    });
    const learned = await recordTaskSplitOutcome(config, task, "execution");
    assert.equal(learned?.sampleCount, 0);
    assert.equal(learned?.successCount, 0);
    assert.equal(learned?.recommendedLeafScale, 1);
    assert.equal(learned?.recommendedMaxInputTokens, budget.maxInputTokens);
    assert.equal(learned?.recommendedMaxOutputTokens, budget.maxOutputTokens);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-v3 split memory is quarantined so rc.1 protocol pollution cannot constrain schema v4", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-split-legacy-"));
  try {
    const config = testConfig(root);
    config.controller.splitMemory.minSamplesForEnforcement = 1;
    const initial = await adviseSplit(config, root, descriptor("legacy-pollution"));
    const task = record(root, "legacy-seed", "legacy-pollution", initial.decision, "completed");
    await createTask(config, task);
    await appendUsageEvent(task, {
      id: "legacy-usage",
      kind: "request_completed",
      usageSource: "provider",
      inputTokens: 10,
      outputTokens: 2,
    });
    await recordTaskSplitOutcome(config, task, "execution");
    const profileRoot = path.join(config.stateRoot, "split-memory");
    const locate = async (directory: string): Promise<string> => {
      for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          try { return await locate(target); } catch { /* keep searching */ }
        } else if (entry.isFile() && entry.name.endsWith(".json") && target.includes(`${path.sep}profiles${path.sep}`)) return target;
      }
      throw new Error("profile not found");
    };
    const profilePath = await locate(profileRoot);
    const fs = await import("node:fs/promises");
    const legacy = JSON.parse(await fs.readFile(profilePath, "utf8")) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    legacy.sampleCount = 8;
    legacy.anomalyCount = 4;
    legacy.recommendedLeafScale = 0.25;
    legacy.recommendedComplexity = "trivial";
    legacy.recommendedMaxInputTokens = 26_150;
    legacy.recommendedMaxOutputTokens = 34_867;
    await fs.writeFile(profilePath, `${JSON.stringify(legacy, null, 2)}\n`);

    const next = await adviseSplit(config, root, descriptor("legacy-pollution"));
    assert.equal(next.profile, undefined);
    assert.equal(next.decision.memorySchemaVersion, 4);
    assert.equal(next.decision.sampleCount, 0);
    assert.equal(next.decision.ignoredLegacySampleCount, 8);
    assert.equal(next.decision.ignoredLegacySchemaVersion, 3);
    assert.equal(next.decision.recommendedLeafScale, 1);
    assert.equal(next.decision.recommendedComplexity, "medium");
    assert.equal(next.decision.recommendedMaxInputTokens, budget.maxInputTokens);
    assert.equal(next.decision.recommendedMaxOutputTokens, budget.maxOutputTokens);

    const cleanTask = record(root, "schema4-seed", "legacy-pollution", next.decision, "completed");
    await createTask(config, cleanTask);
    await appendUsageEvent(cleanTask, {
      id: "schema4-usage",
      kind: "request_completed",
      usageSource: "provider",
      inputTokens: 12,
      outputTokens: 3,
    });
    const migrated = await recordTaskSplitOutcome(config, cleanTask, "execution");
    assert.equal(migrated?.schemaVersion, 4);
    assert.equal(migrated?.sampleCount, 1);
    assert.equal(migrated?.successCount, 1);
    assert.equal(migrated?.ignoredLegacySampleCount, 8);
    const legacyArchive = path.join(config.stateRoot, "split-memory", migrated?.repoKey ?? "", "legacy", `${migrated?.memoryKey}.schema-v3.json`);
    assert.equal(await fs.stat(legacyArchive).then(() => true, () => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
