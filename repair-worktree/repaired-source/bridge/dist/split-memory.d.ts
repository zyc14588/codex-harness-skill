import type { BridgeConfig, HarnessExecutionMode, RequestedExecutor, SplitDecisionSnapshot, SplitMemoryProfile, SplitOutcomeStage, TaskBudget, TaskComplexity, TaskMode, TaskRecord, WorkerExecutor } from "./types.js";
export declare const SPLIT_MEMORY_SCHEMA_VERSION: 4;
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
export declare function splitRepoKey(repoRoot: string): string;
export declare function splitMemoryKey(descriptor: Omit<SplitCandidateDescriptor, "defaultBudget" | "proposedComplexity">): string;
export declare function loadSplitMemoryProfile(config: BridgeConfig, repoRoot: string, memoryKey: string): Promise<SplitMemoryProfile | undefined>;
export declare function adviseSplit(config: BridgeConfig, repoRoot: string, descriptor: SplitCandidateDescriptor): Promise<SplitAdvice>;
export declare function recordTaskSplitOutcome(config: BridgeConfig, task: TaskRecord, stage: SplitOutcomeStage): Promise<SplitMemoryProfile | undefined>;
export declare function listSplitMemoryProfiles(config: BridgeConfig, repoRoot?: string): Promise<SplitMemoryProfile[]>;
