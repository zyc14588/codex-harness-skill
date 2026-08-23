import type { InfrastructureFailureKind, SplitOutcomeAttribution, TaskRecord } from "./types.js";
export interface InfrastructureFailureDefinition {
    infrastructure: boolean;
    attemptAbort: boolean;
    retryable: boolean;
    attribution: SplitOutcomeAttribution;
}
/** Sole runtime taxonomy used by proxy, worker fail-fast and split memory. */
export declare const INFRASTRUCTURE_FAILURE_TAXONOMY: Readonly<Record<InfrastructureFailureKind, InfrastructureFailureDefinition>>;
export declare const ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS = 422;
export declare function attemptInfrastructureAbortReason(task: Pick<TaskRecord, "infrastructureFailureKind" | "infrastructureFailureDetails">): string | undefined;
export declare function providerHttpFailureKind(status: number): Extract<InfrastructureFailureKind, "provider_protocol" | "provider_transport">;
export interface NormalizedProviderHttpFailure {
    kind: Extract<InfrastructureFailureKind, "provider_credential" | "provider_protocol" | "provider_transport">;
    category: "authentication" | "context_limit" | "output_limit" | "rate_limit" | "reasoning_replay" | "server" | "thinking_policy" | "tool_choice" | "invalid_request";
    details: string;
}
/** Persist only a bounded category, never an arbitrary Provider error body. */
export declare function normalizeProviderHttpFailure(status: number, body: Buffer): NormalizedProviderHttpFailure;
export declare function infrastructureAnomalyLabels(task: Pick<TaskRecord, "infrastructureFailureKind">): string[];
export declare function failureAttribution(kind: InfrastructureFailureKind | undefined): SplitOutcomeAttribution | undefined;
