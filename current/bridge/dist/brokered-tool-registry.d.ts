import type { ProcessIdentity } from "./types.js";
export interface BrokeredToolRegistryEntry {
    requestId: string;
    taskId: string;
    attemptId: string;
    registeredAt: string;
    processIdentity?: ProcessIdentity;
}
export interface BrokeredToolRegistryLease {
    requestId: string;
    signal: AbortSignal;
    bindProcess(identity: ProcessIdentity): void;
    close(): void;
}
export declare class BrokeredToolProcessRegistry {
    #private;
    open(taskId: string, attemptId: string, requestSignal: AbortSignal): BrokeredToolRegistryLease;
    snapshot(): BrokeredToolRegistryEntry[];
    abortRequest(requestId: string, reason?: string): boolean;
    abortTask(taskId: string, reason?: string): number;
    abortAttemptMismatch(taskId: string, activeAttemptId: string | undefined): number;
    abortAll(reason?: string): number;
    waitForEmpty(timeoutMs: number): Promise<boolean>;
}
export declare const brokeredToolProcessRegistry: BrokeredToolProcessRegistry;
