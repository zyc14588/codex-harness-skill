import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  BridgeConfig,
  HarnessExecutionMode,
  RequestedExecutor,
  SplitDecisionSnapshot,
  SplitMemoryProfile,
  SplitOutcomeEvent,
  SplitOutcomeStage,
  TaskBudget,
  TaskComplexity,
  TaskMode,
  TaskRecord,
  UsageTotals,
  WorkerExecutor,
} from "./types.js";
import { withNamedLock } from "./store.js";
import { usageForBudgetGroup } from "./telemetry.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists, readJson } from "./util.js";

export const SPLIT_MEMORY_SCHEMA_VERSION = 3 as const;
const COMPLEXITIES: TaskComplexity[] = ["trivial", "small", "medium", "large"];

export interface SplitCandidateDescriptor {
  taskFamily: string;
  requestedExecutor: RequestedExecutor;
  executor: WorkerExecutor;
  model?: string;
  harnessMode: HarnessExecutionMode;
  mode: Exclude<TaskMode, "repair">;
  proposedComplexity: TaskComplexity;
  defaultBudget: TaskBudget;
}

export interface SplitAdvice {
  repoKey: string;
  memoryKey: string;
  profile?: SplitMemoryProfile;
  decision: SplitDecisionSnapshot;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function splitRepoKey(repoRoot: string): string {
  return safeSegment(path.resolve(repoRoot));
}

export function splitMemoryKey(descriptor: Omit<SplitCandidateDescriptor, "defaultBudget" | "proposedComplexity">): string {
  const modelTier = descriptor.executor === "llama_cpp"
    ? `llama:${descriptor.model ?? "local"}`
    : `harness:${descriptor.model ?? "default"}:${descriptor.harnessMode}`;
  return safeSegment(`${descriptor.taskFamily}\n${descriptor.mode}\n${modelTier}`);
}

function profilePath(config: BridgeConfig, repoKey: string, memoryKey: string): string {
  return path.join(config.stateRoot, "split-memory", repoKey, "profiles", `${memoryKey}.json`);
}

function eventPath(config: BridgeConfig, repoKey: string, eventId: string): string {
  return path.join(config.stateRoot, "split-memory", repoKey, "events", `${safeSegment(eventId)}.json`);
}

function downgrade(complexity: TaskComplexity, steps = 1): TaskComplexity {
  const index = COMPLEXITIES.indexOf(complexity);
  return COMPLEXITIES[Math.max(0, index - steps)] ?? "trivial";
}

function upgrade(complexity: TaskComplexity, steps = 1): TaskComplexity {
  const index = COMPLEXITIES.indexOf(complexity);
  return COMPLEXITIES[Math.min(COMPLEXITIES.length - 1, index + steps)] ?? "large";
}

function recommendedComplexity(
  proposed: TaskComplexity,
  profile: SplitMemoryProfile | undefined,
  minSamples: number,
): TaskComplexity {
  if (!profile || profile.sampleCount < minSamples) return proposed;
  // The profile recommendation is anchored to the last observed leaf. Reapplying
  // the scale to each new proposal would repeatedly downgrade medium → small →
  // trivial before the smaller leaf had a chance to run and produce evidence.
  return profile.recommendedComplexity;
}

interface LoadedSplitMemory {
  profile?: SplitMemoryProfile;
  ignoredLegacySampleCount: number;
  ignoredLegacySchemaVersion?: number;
}

async function loadSplitMemory(
  config: BridgeConfig,
  repoRoot: string,
  memoryKey: string,
): Promise<LoadedSplitMemory> {
  const target = profilePath(config, splitRepoKey(repoRoot), memoryKey);
  if (!await pathExists(target)) return { ignoredLegacySampleCount: 0 };
  try {
    const value = await readJson<SplitMemoryProfile | { schemaVersion?: number; sampleCount?: number }>(target);
    if (value.schemaVersion === SPLIT_MEMORY_SCHEMA_VERSION) {
      return { profile: value as SplitMemoryProfile, ignoredLegacySampleCount: 0 };
    }
    return {
      ignoredLegacySampleCount: typeof value.sampleCount === "number" && Number.isFinite(value.sampleCount)
        ? Math.max(0, Math.floor(value.sampleCount))
        : 0,
      ...(typeof value.schemaVersion === "number" ? { ignoredLegacySchemaVersion: value.schemaVersion } : {}),
    };
  } catch { return { ignoredLegacySampleCount: 0 }; }
}

export async function loadSplitMemoryProfile(
  config: BridgeConfig,
  repoRoot: string,
  memoryKey: string,
): Promise<SplitMemoryProfile | undefined> {
  return (await loadSplitMemory(config, repoRoot, memoryKey)).profile;
}

export async function adviseSplit(
  config: BridgeConfig,
  repoRoot: string,
  descriptor: SplitCandidateDescriptor,
): Promise<SplitAdvice> {
  const repoKey = splitRepoKey(repoRoot);
  const memoryKey = splitMemoryKey(descriptor);
  const loaded = config.controller.splitMemory.enabled
    ? await loadSplitMemory(config, repoRoot, memoryKey)
    : { ignoredLegacySampleCount: 0 };
  const profile = loaded.profile;
  const sampleCount = profile?.sampleCount ?? 0;
  const confidence = config.controller.splitMemory.enabled
    ? clamp(sampleCount / Math.max(1, config.controller.splitMemory.minSamplesForEnforcement * 2), 0, 1)
    : 0;
  const leafScale = profile?.recommendedLeafScale ?? 1;
  const complexity = recommendedComplexity(
    descriptor.proposedComplexity,
    profile,
    config.controller.splitMemory.minSamplesForEnforcement,
  );
  const defaultInput = descriptor.defaultBudget.maxInputTokens;
  const defaultOutput = descriptor.defaultBudget.maxOutputTokens;
  const rememberedInput = profile?.recommendedMaxInputTokens ?? defaultInput;
  const rememberedOutput = profile?.recommendedMaxOutputTokens ?? defaultOutput;
  const rationale: string[] = [];
  if (!config.controller.splitMemory.enabled) rationale.push("adaptive split memory is disabled by operator configuration");
  else if (!profile) {
    rationale.push("no matching schema-v3 historical profile; retain the proposed leaf size and token gates");
    if (loaded.ignoredLegacySampleCount > 0 || loaded.ignoredLegacySchemaVersion !== undefined) {
      rationale.push(`ignored legacy split-memory schema v${loaded.ignoredLegacySchemaVersion ?? "unknown"} with ${loaded.ignoredLegacySampleCount} sample(s)`);
    }
  }
  else {
    rationale.push(`${profile.sampleCount} historical outcome sample(s), anomaly rate ${rounded(profile.anomalyCount / Math.max(1, profile.sampleCount), 3)}`);
    rationale.push(`recommended leaf scale ${rounded(leafScale, 3)} relative to the previous accepted split`);
    if (complexity !== descriptor.proposedComplexity) rationale.push(`historical outcomes recommend ${complexity} instead of ${descriptor.proposedComplexity}`);
    if (profile.tokenGateExceededCount > 0) rationale.push(`${profile.tokenGateExceededCount} token-gate overrun(s) require smaller leaves and observed-usage safety margin`);
    if (profile.repairCount > 0 || profile.verificationFailureCount > 0) rationale.push("repair or verification failures reduce the next leaf size");
    if (profile.infrastructureFailureCount > 0) rationale.push(`${profile.infrastructureFailureCount} infrastructure failure(s) were recorded separately and did not shrink leaf sizing`);
  }
  return {
    repoKey,
    memoryKey,
    ...(profile ? { profile } : {}),
    decision: {
      memorySchemaVersion: SPLIT_MEMORY_SCHEMA_VERSION,
      memoryKey,
      taskFamily: descriptor.taskFamily,
      memoryRevision: profile?.revision ?? 0,
      sampleCount,
      ignoredLegacySampleCount: loaded.ignoredLegacySampleCount,
      ...(loaded.ignoredLegacySchemaVersion === undefined ? {} : { ignoredLegacySchemaVersion: loaded.ignoredLegacySchemaVersion }),
      confidence: rounded(confidence),
      recommendedLeafScale: rounded(leafScale),
      recommendedComplexity: complexity,
      recommendedMaxInputTokens: Math.max(1, Math.round(rememberedInput)),
      recommendedMaxOutputTokens: Math.max(1, Math.round(rememberedOutput)),
      anomalyRate: rounded((profile?.anomalyCount ?? 0) / Math.max(1, sampleCount)),
      rationale,
      chosenComplexity: descriptor.proposedComplexity,
      chosenMaxInputTokens: defaultInput,
      chosenMaxOutputTokens: defaultOutput,
    },
  };
}

function ema(previous: number, current: number, alpha = 0.25): number {
  return previous === 0 ? current : previous * (1 - alpha) + current * alpha;
}

function taskTimedOut(task: TaskRecord): boolean {
  return (task.executionAttempts ?? []).some((item) => item.outcome === "timed_out");
}

function infrastructureAnomalies(task: TaskRecord): string[] {
  const anomalies = new Set<string>();
  if (task.infrastructureFailureKind === "tool_protocol") anomalies.add("tool_protocol_failure");
  if (task.infrastructureFailureKind === "minimal_tool_plane") anomalies.add("minimal_tool_plane_failure");
  if (task.infrastructureFailureKind === "provider_transport") anomalies.add("provider_transport_failure");
  if (task.infrastructureFailureKind === "no_effect") anomalies.add("required_change_missing");
  return [...anomalies].sort();
}

function executionAnomalies(task: TaskRecord, usage: UsageTotals): string[] {
  // Infrastructure/tool-protocol failures are not evidence that Codex chose a
  // leaf that was too large. Keep them out of task-shape learning entirely.
  if (infrastructureAnomalies(task).length > 0) return [];
  const anomalies = new Set<string>();
  const input = usage.inputTokens + usage.estimatedInputTokens;
  const output = usage.outputTokens + usage.estimatedOutputTokens;
  if (input > task.budget.maxInputTokens || /input token budget/i.test(task.error ?? "")) anomalies.add("input_token_gate_exceeded");
  if (output > task.budget.maxOutputTokens || /output token budget/i.test(task.error ?? "")) anomalies.add("output_token_gate_exceeded");
  if (taskTimedOut(task)) anomalies.add("timeout");
  if (task.status === "failed") anomalies.add("execution_failed");
  if (task.status === "scope_violation") anomalies.add("scope_violation");
  if (task.status === "orphaned") anomalies.add("orphaned");
  if (task.fallbackUsed) anomalies.add("fallback_used");
  if (task.parentTaskId || task.mode === "repair") anomalies.add("repair_required");
  return [...anomalies].sort();
}

function stageAnomalies(task: TaskRecord, stage: SplitOutcomeStage, execution: string[]): string[] {
  if (infrastructureAnomalies(task).length > 0) return [];
  if (stage === "execution") return [...execution];
  const anomalies = new Set<string>();
  if (stage === "review" && task.reviewDecision === "revise") anomalies.add("review_revise");
  if (stage === "review" && task.reviewDecision === "rejected") anomalies.add("review_rejected");
  if (stage === "verification" && task.verificationPassed === false) anomalies.add("verification_failed");
  return [...anomalies].sort();
}

function eventStatus(task: TaskRecord, stage: SplitOutcomeStage): string {
  if (stage === "review") return task.reviewDecision ?? "not_reviewed";
  if (stage === "verification") return task.verificationPassed === true ? "passed" : task.verificationPassed === false ? "failed" : "not_verified";
  return task.status;
}

function initialProfile(event: SplitOutcomeEvent, now: string): SplitMemoryProfile {
  return {
    schemaVersion: SPLIT_MEMORY_SCHEMA_VERSION,
    repoKey: event.repoKey,
    memoryKey: event.memoryKey,
    taskFamily: event.taskFamily,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    sampleCount: 0,
    successCount: 0,
    anomalyCount: 0,
    infrastructureFailureCount: 0,
    ignoredLegacySampleCount: 0,
    tokenGateExceededCount: 0,
    timeoutCount: 0,
    repairCount: 0,
    fallbackCount: 0,
    verificationFailureCount: 0,
    emaInputRatio: 0,
    emaOutputRatio: 0,
    emaInputTokens: 0,
    emaOutputTokens: 0,
    emaRuntimeRatio: 0,
    recommendedLeafScale: 1,
    recommendedComplexity: event.chosenComplexity,
    recommendedMaxInputTokens: event.maxInputTokens,
    recommendedMaxOutputTokens: event.maxOutputTokens,
    complexLeafConfidence: 0.5,
    recentEventIds: [],
  };
}

function applyOutcome(config: BridgeConfig, profile: SplitMemoryProfile, event: SplitOutcomeEvent): SplitMemoryProfile {
  const memory = config.controller.splitMemory;
  const next = structuredClone(profile);
  next.revision += 1;
  next.updatedAt = event.at;
  next.lastOutcome = event;
  next.recentEventIds = [...next.recentEventIds, event.id].slice(-memory.maxEventsPerProfile);
  if (event.attribution === "infrastructure") {
    if (event.stage === "execution") next.infrastructureFailureCount += 1;
    return next;
  }
  const severe = event.anomalies.some((item) => [
    "input_token_gate_exceeded", "output_token_gate_exceeded", "timeout", "execution_failed",
    "scope_violation", "orphaned", "review_rejected", "verification_failed",
  ].includes(item));
  const moderate = event.anomalies.some((item) => ["fallback_used", "repair_required", "review_revise"].includes(item));
  const executionStage = event.stage === "execution";
  const learnableExecution = executionStage
    && !(event.status === "completed_no_changes" && event.changedPathCount === 0);
  const successful = learnableExecution
    && event.anomalies.length === 0
    && event.status === "completed"
    && event.changedPathCount > 0;

  next.sampleCount += learnableExecution ? 1 : 0;
  next.successCount += successful ? 1 : 0;
  next.anomalyCount += learnableExecution && event.anomalies.length > 0 ? 1 : 0;
  next.tokenGateExceededCount += learnableExecution && event.anomalies.some((item) => item.endsWith("token_gate_exceeded")) ? 1 : 0;
  next.timeoutCount += learnableExecution && event.anomalies.includes("timeout") ? 1 : 0;
  next.repairCount += (learnableExecution && event.anomalies.includes("repair_required")) || (event.stage === "review" && event.anomalies.includes("review_revise")) ? 1 : 0;
  next.fallbackCount += learnableExecution && event.anomalies.includes("fallback_used") ? 1 : 0;
  next.verificationFailureCount += event.stage === "verification" && event.anomalies.includes("verification_failed") ? 1 : 0;
  if (learnableExecution) {
    next.emaInputRatio = rounded(ema(next.emaInputRatio, event.inputRatio));
    next.emaOutputRatio = rounded(ema(next.emaOutputRatio, event.outputRatio));
    next.emaInputTokens = Math.round(ema(next.emaInputTokens, event.inputTokens));
    next.emaOutputTokens = Math.round(ema(next.emaOutputTokens, event.outputTokens));
    next.emaRuntimeRatio = rounded(ema(next.emaRuntimeRatio, event.runtimeRatio));
  }

  let scale = next.recommendedLeafScale;
  if (severe) scale *= 1 - memory.anomalyPenalty;
  else if (moderate) scale *= 1 - memory.anomalyPenalty / 2;
  else if (successful && Math.max(event.inputRatio, event.outputRatio, event.runtimeRatio) <= 0.75) scale *= 1 + memory.successGrowth;
  next.recommendedLeafScale = rounded(clamp(scale, memory.minimumLeafScale, memory.maximumLeafScale));

  const anomalyRate = next.anomalyCount / Math.max(1, next.sampleCount);
  const stableRate = next.successCount / Math.max(1, next.sampleCount);
  next.complexLeafConfidence = rounded(clamp(0.5 + stableRate * 0.5 - anomalyRate * 0.75 - next.repairCount / Math.max(1, next.sampleCount) * 0.25, 0, 1));
  if (next.sampleCount >= memory.minSamplesForEnforcement) {
    if (next.recommendedLeafScale < 0.5) next.recommendedComplexity = downgrade(event.chosenComplexity, 2);
    else if (next.recommendedLeafScale < 0.82) next.recommendedComplexity = downgrade(event.chosenComplexity, 1);
    else if (next.recommendedLeafScale > 1.2 && next.complexLeafConfidence >= 0.75) next.recommendedComplexity = upgrade(event.chosenComplexity, 1);
    else next.recommendedComplexity = event.chosenComplexity;
  }
  if (learnableExecution) {
    const observedInputTarget = Math.ceil(Math.max(1, next.emaInputTokens) * memory.tokenSafetyFactor);
    const observedOutputTarget = Math.ceil(Math.max(1, next.emaOutputTokens) * memory.tokenSafetyFactor);
    const scaledInputTarget = Math.ceil(event.maxInputTokens * next.recommendedLeafScale);
    const scaledOutputTarget = Math.ceil(event.maxOutputTokens * next.recommendedLeafScale);
    next.recommendedMaxInputTokens = Math.max(1, observedInputTarget, scaledInputTarget);
    next.recommendedMaxOutputTokens = Math.max(1, observedOutputTarget, scaledOutputTarget);
  }
  return next;
}

export async function recordTaskSplitOutcome(
  config: BridgeConfig,
  task: TaskRecord,
  stage: SplitOutcomeStage,
): Promise<SplitMemoryProfile | undefined> {
  if (!config.controller.splitMemory.enabled) return undefined;
  const eventId = `${task.id}:${stage}`;
  const repoKey = splitRepoKey(task.repoRoot);
  const marker = eventPath(config, repoKey, eventId);
  return await withNamedLock(config, `split-memory:${repoKey}:${task.splitDecision.memoryKey}`, 30_000, async () => {
    if (await pathExists(marker)) return await loadSplitMemoryProfile(config, task.repoRoot, task.splitDecision.memoryKey);
    const usage = await usageForBudgetGroup(config, task.budgetGroupId);
    const input = usage.inputTokens + usage.estimatedInputTokens;
    const output = usage.outputTokens + usage.estimatedOutputTokens;
    const runtimeMs = task.startedAt && task.completedAt ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt)) : 0;
    const baseAnomalies = executionAnomalies(task, usage);
    const anomalies = stageAnomalies(task, stage, baseAnomalies);
    const infrastructure = infrastructureAnomalies(task);
    const attribution = infrastructure.length > 0 ? "infrastructure" : anomalies.length > 0 ? "task_shape" : "neutral";
    const event: SplitOutcomeEvent = {
      schemaVersion: SPLIT_MEMORY_SCHEMA_VERSION,
      id: randomUUID(),
      at: nowIso(),
      repoKey,
      memoryKey: task.splitDecision.memoryKey,
      taskFamily: task.taskFamily,
      planId: task.planId,
      leafId: task.leafId,
      taskId: task.id,
      stage,
      executor: task.effectiveExecutor ?? task.executor,
      ...(task.model ? { model: task.model } : {}),
      harnessMode: task.harnessMode,
      chosenComplexity: task.complexity,
      chosenLeafScale: task.splitDecision.recommendedLeafScale,
      maxInputTokens: task.budget.maxInputTokens,
      maxOutputTokens: task.budget.maxOutputTokens,
      inputTokens: input,
      outputTokens: output,
      inputRatio: rounded(input / Math.max(1, task.budget.maxInputTokens)),
      outputRatio: rounded(output / Math.max(1, task.budget.maxOutputTokens)),
      apiCalls: usage.apiCalls,
      costCny: usage.costCny,
      runtimeRatio: rounded(runtimeMs / Math.max(1, task.runtimeSeconds * 1_000)),
      status: eventStatus(task, stage),
      changedPathCount: task.changedPaths.length,
      anomalies,
      infrastructureAnomalies: infrastructure,
      attribution,
      repairRequired: Boolean(task.parentTaskId || task.mode === "repair" || task.reviewDecision === "revise"),
      fallbackUsed: task.fallbackUsed === true,
      ...(task.verificationPassed === undefined ? {} : { verificationPassed: task.verificationPassed }),
      ...(task.reviewDecision === undefined ? {} : { reviewDecision: task.reviewDecision }),
    };
    const target = profilePath(config, repoKey, task.splitDecision.memoryKey);
    let existing = initialProfile(event, event.at);
    if (await pathExists(target)) {
      try {
        const raw = await readJson<SplitMemoryProfile | { schemaVersion?: number; sampleCount?: number }>(target);
        if (raw.schemaVersion === SPLIT_MEMORY_SCHEMA_VERSION) existing = raw as SplitMemoryProfile;
        else {
          existing.ignoredLegacySampleCount = typeof raw.sampleCount === "number" ? raw.sampleCount : 0;
          const legacyVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
          const legacy = path.join(config.stateRoot, "split-memory", repoKey, "legacy", `${task.splitDecision.memoryKey}.schema-v${legacyVersion}.json`);
          if (!await pathExists(legacy)) {
            await ensureDir(path.dirname(legacy));
            await atomicWriteJson(legacy, raw);
          }
        }
      } catch { /* corrupt/legacy profile is isolated from adaptive advice */ }
    }
    const updated = applyOutcome(config, existing, event);
    await ensureDir(path.dirname(target));
    await ensureDir(path.dirname(marker));
    await atomicWriteJson(target, updated);
    await atomicWriteJson(marker, event);
    return updated;
  });
}

export async function listSplitMemoryProfiles(config: BridgeConfig, repoRoot?: string): Promise<SplitMemoryProfile[]> {
  const root = repoRoot
    ? path.join(config.stateRoot, "split-memory", splitRepoKey(repoRoot), "profiles")
    : path.join(config.stateRoot, "split-memory");
  if (!await pathExists(root)) return [];
  const results: SplitMemoryProfile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json") && target.includes(`${path.sep}profiles${path.sep}`)) {
        try {
          const value = JSON.parse(await readFile(target, "utf8")) as SplitMemoryProfile | { schemaVersion?: number };
          if (value.schemaVersion === SPLIT_MEMORY_SCHEMA_VERSION) results.push(value as SplitMemoryProfile);
        } catch { /* ignore corrupt or legacy profile */ }
      }
    }
  };
  await visit(root);
  return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
