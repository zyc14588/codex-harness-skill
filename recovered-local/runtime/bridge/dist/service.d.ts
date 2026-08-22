import type { BridgeConfig, HarnessExecutionMode, ProgressiveToolCapability, RequestedExecutor, ReviewDecision, TaskBudget, TaskComplexity } from "./types.js";
import { resolveHarnessLauncher } from "./config.js";
import { jsonToolResult } from "./util.js";
export declare function assertHarnessProvenance(config: BridgeConfig): Promise<Awaited<ReturnType<typeof resolveHarnessLauncher>>>;
export interface ControllerLeafInput {
    id: string;
    objective: string;
    executor?: RequestedExecutor;
    complexity: "trivial" | "small" | "medium" | "large";
    mode?: "implementation" | "test" | "review" | "analysis";
    harnessMode?: HarnessExecutionMode;
    parallelGroup?: string;
    dependsOn?: string[];
    toolCapabilities?: ProgressiveToolCapability[];
    taskFamily?: string;
    splitRationale?: string;
    memoryOverrideReason?: string;
    harnessWritePaths: string[];
    codexWritePaths?: string[];
    acceptanceCriteria: string[];
    contextFiles?: string[];
    verificationCommands: string[];
    runtimeSeconds?: number;
    model?: string;
    budget?: Partial<TaskBudget>;
}
export interface CreateControllerPlanInput {
    repoRoot: string;
    leaves: ControllerLeafInput[];
    baseRef?: string;
    planId?: string;
    userRequestedLlamaCpp?: boolean;
}
export declare function createControllerPlan(input: CreateControllerPlanInput): Promise<unknown>;
export declare function controllerPlanStatus(planId: string): Promise<unknown>;
export declare function listControllerPlans(limit: number): Promise<unknown>;
export interface SplitAdviceCandidateInput {
    id: string;
    taskFamily: string;
    executor?: RequestedExecutor;
    model?: string;
    harnessMode?: HarnessExecutionMode;
    mode?: "implementation" | "test" | "review" | "analysis";
    complexity: TaskComplexity;
    proComplex?: boolean;
}
export declare function controllerSplitAdvice(repoRootInput: string, candidates: SplitAdviceCandidateInput[]): Promise<unknown>;
export declare function controllerSplitMemory(repoRootInput?: string): Promise<unknown>;
export declare function doctor(probeHarness: boolean): Promise<unknown>;
export interface StartTaskInput {
    planId: string;
    leafId: string;
    taskId?: string;
}
export declare function startTask(input: StartTaskInput): Promise<unknown>;
export declare function taskStatus(taskId: string): Promise<unknown>;
export declare function collectTask(taskId: string, includePatch: boolean, maxPatchChars: number): Promise<unknown>;
export declare function readChangedFile(taskId: string, filePath: string): Promise<unknown>;
export declare function reviewTask(taskId: string, decision: ReviewDecision, reviewedPaths: string[], notes: string): Promise<unknown>;
export declare function repairTask(parentTaskId: string, feedback: string, runtimeSeconds?: number): Promise<unknown>;
export declare function verifyTask(taskId: string, commands?: string[], timeoutSeconds?: number): Promise<unknown>;
export declare function commitTask(taskId: string, message?: string): Promise<unknown>;
export declare function cancelTask(taskId: string): Promise<unknown>;
export declare function cleanupTask(taskId: string, force: boolean, deleteTaskBranch: boolean): Promise<unknown>;
export declare function listRecentTasks(limit: number): Promise<unknown>;
export declare function finalizeControllerPlan(planId: string, integrationEvidence: string): Promise<unknown>;
export declare function monitorStatus(): Promise<unknown>;
export declare function monitorSnapshot(limit: number): Promise<unknown>;
export declare function monitorStop(): Promise<unknown>;
export { jsonToolResult };
