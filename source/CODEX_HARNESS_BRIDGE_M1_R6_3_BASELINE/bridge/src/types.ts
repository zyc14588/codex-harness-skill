export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_no_changes"
  | "scope_violation"
  | "failed"
  | "cancelled"
  | "orphaned";

export type WorkerExecutor = "harness" | "llama_cpp";
export type RequestedExecutor = "auto" | WorkerExecutor;
export type TaskComplexity = "trivial" | "small" | "medium" | "large";
export type TaskMode = "implementation" | "test" | "review" | "analysis" | "repair";
export type ReviewDecision = "approved" | "revise" | "rejected";
export type ControllerLeafStatus = "planned" | "running" | "completed" | "reviewed" | "verified" | "accepted" | "rejected";
export type ControllerPlanStatus = "planned" | "running" | "accepted" | "rejected";
export type LlamaCppMode = "external_server" | "managed_server" | "cli";
export type BudgetEnforcement = "hard" | "advisory";
export type BudgetGatePolicy = "input_output_tokens";
export type BudgetCeilingPolicy = "operator_bounded" | "unbounded";
export type HarnessExecutionMode = "minimal" | "standard";
export type ProgressiveToolCapability = "repository_read" | "verification" | "git_inspect";
export type ToolProtocolRecoveryKind =
  | "dsml_content_to_tool_calls"
  | "structured_tool_call_delta_normalized"
  | "markdown_shell_fence_to_tool_calls"
  | "text_tool_call_envelope_to_tool_calls";
export type InfrastructureFailureKind =
  | "tool_protocol"
  | "minimal_tool_plane"
  | "provider_transport"
  | "no_effect";
export type SplitOutcomeAttribution = "task_shape" | "infrastructure" | "neutral";

/**
 * CNY is the operator-facing and primary budget currency in schema v4.
 * maxCostUsd is retained as a hidden legacy/secondary safety ceiling so old
 * tasks and custom USD-only providers remain enforceable during migration.
 */
export interface TaskBudget {
  /** R6 gates only on cumulative input/output tokens. Calls and cost are reference telemetry. */
  gatePolicy?: BudgetGatePolicy;
  /** Pro complex leaves may choose unbounded operator ceiling while still enforcing their frozen token gates. */
  ceilingPolicy?: BudgetCeilingPolicy;
  /** Retained for migration/UI semantics. R6 token gates are hard for every executable leaf. */
  enforcement?: BudgetEnforcement;
  maxApiCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostCny: number;
  maxCostUsd: number;
}

/** At least one complete currency triplet must be configured for a model. */
export interface PricingEntry {
  inputCacheHitCnyPerMillion?: number;
  inputCacheMissCnyPerMillion?: number;
  outputCnyPerMillion?: number;
  inputCacheHitUsdPerMillion?: number;
  inputCacheMissUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface SplitMemoryConfig {
  enabled: boolean;
  minSamplesForEnforcement: number;
  maxEventsPerProfile: number;
  minimumLeafScale: number;
  maximumLeafScale: number;
  anomalyPenalty: number;
  successGrowth: number;
  tokenSafetyFactor: number;
}

export interface ControllerConfig {
  requirePlan: boolean;
  maxLeavesPerPlan: number;
  maxHarnessWriteLeases: number;
  maxHarnessContextFiles: number;
  maxHarnessAcceptanceCriteria: number;
  maxHarnessObjectiveChars: number;
  defaultHarnessBudget: TaskBudget;
  maximumHarnessBudget: TaskBudget;
  /** High token gate used only by large Harness leaves pinned to deepseek-v4-pro. */
  defaultProComplexBudget: TaskBudget;
  maxConcurrentHarnessGlobal: number;
  maxConcurrentHarnessPerRepo: number;
  preferMinimalHarness: boolean;
  splitMemory: SplitMemoryConfig;
}

export interface MonitorCurrencyConfig {
  primary: "CNY";
  showUsd: boolean;
  usdToCnyRate: number | null;
  fxAsOf: string;
  fxSource: string;
}

export interface MonitorConfig {
  enabled: boolean;
  host: string;
  port: number;
  autoStart: boolean;
  charsPerEstimatedToken: number;
  pricingAsOf: string;
  pricing: Record<string, PricingEntry>;
  currency: MonitorCurrencyConfig;
}

export interface LlamaCppConfig {
  enabled: boolean;
  autoRouteSimpleLeaves: boolean;
  mode: LlamaCppMode;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  workingDirectory?: string;
  serverBinary: string;
  serverArgs: string[];
  serverAutoStart: boolean;
  serverStartupTimeoutSeconds: number;
  cliBinary: string;
  cliArgs: string[];
  requestTimeoutSeconds: number;
  maxFilesPerTask: number;
  maxContextFiles: number;
  maxContextBytes: number;
  maxFileBytes: number;
  maxOutputTokens: number;
  fallbackEnabled: boolean;
  fallbackModel: "deepseek-v4-flash";
}

export interface BridgeConfig {
  schemaVersion: 6;
  harnessRoot: string;
  harnessCli?: string;
  harnessBuildRoot?: string;
  harnessProfile: string;
  harnessMinimalProfile: string;
  dshHome?: string;
  stateRoot: string;
  allowedRepoRoots: string[];
  passEnvironment: string[];
  defaultRuntimeSeconds: number;
  maxRuntimeSeconds: number;
  logTailChars: number;
  pinnedHarnessCommit?: string;
  pinnedHarnessBuildSha256?: string;
  enforceHarnessPin: boolean;
  enforceHarnessBuildHash: boolean;
  requireCleanRepoAtStart: boolean;
  allowDirtyHarnessCheckout: boolean;
  controller: ControllerConfig;
  monitor: MonitorConfig;
  llamaCpp: LlamaCppConfig;
}

export interface SplitDecisionSnapshot {
  memorySchemaVersion: 3;
  memoryKey: string;
  taskFamily: string;
  memoryRevision: number;
  sampleCount: number;
  ignoredLegacySampleCount: number;
  ignoredLegacySchemaVersion?: number;
  confidence: number;
  recommendedLeafScale: number;
  recommendedComplexity: TaskComplexity;
  recommendedMaxInputTokens: number;
  recommendedMaxOutputTokens: number;
  anomalyRate: number;
  rationale: string[];
  chosenComplexity: TaskComplexity;
  chosenMaxInputTokens: number;
  chosenMaxOutputTokens: number;
  overrideReason?: string;
}

export interface ControllerLeaf {
  id: string;
  objective: string;
  requestedExecutor: RequestedExecutor;
  executor: WorkerExecutor;
  routingReason: string;
  complexity: TaskComplexity;
  harnessMode: HarnessExecutionMode;
  parallelGroup?: string;
  dependsOn: string[];
  toolCapabilities: ProgressiveToolCapability[];
  taskFamily: string;
  splitRationale: string;
  splitDecision: SplitDecisionSnapshot;
  mode: Exclude<TaskMode, "repair">;
  harnessWritePaths: string[];
  codexWritePaths: string[];
  acceptanceCriteria: string[];
  contextFiles: string[];
  verificationCommands: string[];
  runtimeSeconds: number;
  model?: string;
  budget: TaskBudget;
  status: ControllerLeafStatus;
  activeTaskId?: string;
  completedTaskId?: string;
  reviewDecision?: ReviewDecision;
  reviewedFingerprint?: string;
  verifiedFingerprint?: string;
  bridgeCommit?: string;
}

export interface ControllerPlan {
  schemaVersion: 6;
  id: string;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  status: ControllerPlanStatus;
  /** Retained for reading v1 plans; UI enablement is the v3 authorization. */
  userRequestedLlamaCpp: boolean;
  planHash: string;
  leaves: ControllerLeaf[];
  integrationEvidence?: string;
  splitMemoryApplied: boolean;
}

export interface ExecutionAttempt {
  executor: WorkerExecutor;
  model?: string;
  startedAt: string;
  completedAt?: string;
  outcome?: "completed" | "failed" | "timed_out" | "cancelled";
  error?: string;
}

export interface TaskRecord {
  schemaVersion: 6;
  id: string;
  planId: string;
  leafId: string;
  parentTaskId?: string;
  budgetGroupId: string;
  requestedExecutor: RequestedExecutor;
  executor: WorkerExecutor;
  effectiveExecutor?: WorkerExecutor;
  routingReason?: string;
  complexity: TaskComplexity;
  harnessMode: HarnessExecutionMode;
  parallelGroup?: string;
  dependsOn: string[];
  toolCapabilities: ProgressiveToolCapability[];
  taskFamily: string;
  splitDecision: SplitDecisionSnapshot;
  mode: TaskMode;
  phase?: string;
  objective: string;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  startingHeadCommit: string;
  branchName: string;
  worktreePath: string;
  harnessWritePaths: string[];
  codexWritePaths: string[];
  acceptanceCriteria: string[];
  contextFiles: string[];
  verificationCommands: string[];
  budget: TaskBudget;
  model?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cleanedAt?: string;
  workerPid?: number;
  workerDeadObservedAt?: string;
  harnessPid?: number;
  exitCode?: number | null;
  runtimeSeconds: number;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  usagePath: string;
  proxyToken?: string;
  dashboardUrl?: string;
  upstreamBaseUrl?: string;
  changedPaths: string[];
  outOfScopePaths: string[];
  unsafeSymlinkPaths?: string[];
  unsafeGitlinkPaths?: string[];
  stagedPaths?: string[];
  resultSummary?: string;
  error?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  fallbackModel?: string;
  executionAttempts?: ExecutionAttempt[];
  reviewDecision?: ReviewDecision;
  reviewNotes?: string;
  reviewedPaths?: string[];
  reviewedAt?: string;
  reviewedFingerprint?: string;
  verificationPassed?: boolean;
  verifiedAt?: string;
  verifiedCommands?: string[];
  verifiedFingerprint?: string;
  bridgeCommit?: string;
  bridgeCommittedAt?: string;
  worktreeRemoved?: boolean;
  branchDeleted?: boolean;
  splitOutcomeRecordedAt?: string;
  splitOutcomeRevision?: number;
  toolProtocolRecoveryCount?: number;
  toolProtocolRecoveryKinds?: ToolProtocolRecoveryKind[];
  toolProtocolRecoveredTools?: string[];
  toolProtocolNativeCallCount?: number;
  toolProtocolNativeTools?: string[];
  minimalMutationForceCount?: number;
  minimalMutationForcedTools?: string[];
  minimalMutationPolicyVersion?: string;
  minimalMutationLastAt?: string;
  toolProtocolFailure?: string;
  toolProtocolFailureAt?: string;
  infrastructureFailureKind?: InfrastructureFailureKind;
  infrastructureFailureDetails?: string;
  referenceAlerts?: string[];
}

export type UsageSource = "provider" | "estimated" | "local";
export type UsageEventKind =
  | "request_started"
  | "request_completed"
  | "request_failed"
  | "local_completion"
  | "budget_exceeded";

export interface UsageEvent {
  id: string;
  at?: string;
  taskId?: string;
  budgetGroupId?: string;
  kind: UsageEventKind;
  model?: string;
  upstream?: string;
  httpStatus?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  costCny?: number;
  costUsd?: number;
  usageSource: UsageSource;
  error?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
}

export interface UsageTotals {
  apiCalls: number;
  completedCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  costCny: number;
  costUsd: number;
  unpricedCalls: number;
  lastEventAt?: string;
}

export interface BudgetMarker {
  budgetGroupId: string;
  taskId: string;
  reason: string;
  at: string;
  totals: UsageTotals;
}

export interface OperatorControls {
  schemaVersion: 1;
  updatedAt: string;
  updatedBy: string;
  budgetPolicy: {
    defaultHarnessBudget: TaskBudget;
    maximumHarnessBudget: TaskBudget;
    defaultProComplexBudget: TaskBudget;
  };
  llamaCpp: LlamaCppConfig;
}

export interface BudgetOverrideRecord {
  schemaVersion: 1;
  budgetGroupId: string;
  budget: TaskBudget;
  reason: string;
  updatedAt: string;
  updatedBy: string;
}

export interface BudgetControlEvent {
  id: string;
  at: string;
  actor: string;
  scope: "policy" | "budget_group";
  budgetGroupId?: string;
  reason: string;
  before: unknown;
  after: unknown;
}

export interface ManagedLlamaServerState {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  command: string;
  args: string[];
  baseUrl: string;
  logPath: string;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}


export type SplitOutcomeStage = "execution" | "review" | "verification" | "finalization";

export interface SplitOutcomeEvent {
  schemaVersion: 3;
  id: string;
  at: string;
  repoKey: string;
  memoryKey: string;
  taskFamily: string;
  planId: string;
  leafId: string;
  taskId: string;
  stage: SplitOutcomeStage;
  executor: WorkerExecutor;
  model?: string;
  harnessMode: HarnessExecutionMode;
  chosenComplexity: TaskComplexity;
  chosenLeafScale: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputRatio: number;
  outputRatio: number;
  apiCalls: number;
  costCny: number;
  runtimeRatio: number;
  status: string;
  changedPathCount: number;
  anomalies: string[];
  infrastructureAnomalies: string[];
  attribution: SplitOutcomeAttribution;
  repairRequired: boolean;
  fallbackUsed: boolean;
  verificationPassed?: boolean;
  reviewDecision?: ReviewDecision;
}

export interface SplitMemoryProfile {
  schemaVersion: 3;
  repoKey: string;
  memoryKey: string;
  taskFamily: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sampleCount: number;
  successCount: number;
  anomalyCount: number;
  infrastructureFailureCount: number;
  ignoredLegacySampleCount: number;
  tokenGateExceededCount: number;
  timeoutCount: number;
  repairCount: number;
  fallbackCount: number;
  verificationFailureCount: number;
  emaInputRatio: number;
  emaOutputRatio: number;
  emaInputTokens: number;
  emaOutputTokens: number;
  emaRuntimeRatio: number;
  recommendedLeafScale: number;
  recommendedComplexity: TaskComplexity;
  recommendedMaxInputTokens: number;
  recommendedMaxOutputTokens: number;
  complexLeafConfidence: number;
  recentEventIds: string[];
  lastOutcome?: SplitOutcomeEvent;
}
