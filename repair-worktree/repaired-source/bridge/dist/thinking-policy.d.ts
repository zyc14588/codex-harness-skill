import type { AttemptThinkingPolicy, ExecutionAttempt, ReasoningReplayRequirement, TaskRecord, ThinkingRequestEvidence } from "./types.js";
export declare const ATTEMPT_THINKING_POLICY_VERSION: "attempt-thinking-policy-v1";
export declare function thinkingPolicyForModel(model: string, frozenAt: string): AttemptThinkingPolicy | undefined;
/** Build a new attempt with its DeepSeek mode frozen before the process starts. */
export declare function createExecutionAttempt(executor: ExecutionAttempt["executor"], model: string | undefined, ordinal: number, startedAt: string): ExecutionAttempt;
/**
 * Backward-compatible lazy freeze for queued records created by an older
 * Bridge. The freeze still happens before the first Provider request.
 */
export declare function ensureAttemptThinkingPolicy(task: TaskRecord, model: string, frozenAt: string): string | undefined;
interface ReplayValidation {
    ok: boolean;
    replayedRequirementOrdinals: number[];
    message?: string;
}
export declare function validateReasoningReplay(messages: unknown, requirements: readonly ReasoningReplayRequirement[]): ReplayValidation;
export type ThinkingRequestPreflight = {
    ok: true;
    attempt: ExecutionAttempt & {
        id: string;
        thinkingPolicy: AttemptThinkingPolicy;
    };
    evidence: ThinkingRequestEvidence;
} | {
    ok: false;
    kind: "thinking_policy_state" | "thinking_replay_state";
    message: string;
};
/** Validate the final wire shape. This function never repairs a mode switch. */
export declare function preflightThinkingRequest(task: TaskRecord, body: Record<string, unknown>, model: string, providerSentAt: string): ThinkingRequestPreflight;
export type ReasoningCaptureResult = {
    ok: true;
    requirement?: ReasoningReplayRequirement;
} | {
    ok: false;
    message: string;
};
/** Derive replay integrity metadata from the exact response sent to Harness. */
export declare function captureReasoningRequirement(contentType: string, capture: Buffer, attemptId: string, responseRequestOrdinal: number, recordedAt: string): ReasoningCaptureResult;
export declare function appendThinkingEvidence(task: TaskRecord, evidence: ThinkingRequestEvidence): void;
export {};
