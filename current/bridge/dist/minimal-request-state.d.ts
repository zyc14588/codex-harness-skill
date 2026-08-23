import type { InfrastructureFailureKind, MinimalRequestEvidence, MinimalRequestPurpose, TaskRecord } from "./types.js";
export interface RunnerToolSnapshotInput {
    taskId: string;
    presetId: string;
    visibleTools: readonly string[];
    assembledTools: readonly string[];
    /** Exact runner-owned preflight requirements; tests may supply a smaller deterministic catalog. */
    requiredTools?: readonly string[];
}
export interface AdapterRequestInput {
    taskId: string;
    purpose?: string;
    toolNames: readonly string[];
    reasoningEffort?: string;
}
export interface RedactedRequestEnvelope {
    endpoint: string;
    topLevelKeys: string[];
    toolSchemaCount: number;
    wireToolNames: string[];
    proxyParsedToolNames: string[];
    messageRoles: string[];
    maxTokens?: number;
    thinkingType?: string;
    contractMarkerPresent: boolean;
}
export type WireRequestClaim = {
    ok: true;
    evidence: MinimalRequestEvidence;
} | {
    ok: false;
    kind: Extract<InfrastructureFailureKind, "minimal_tool_plane_composition" | "minimal_tool_serialization_mismatch">;
    message: string;
};
/** Record the actual Agent-scoped and assembled tool catalogs before followup. */
export declare function publishMinimalRunnerSnapshot(input: RunnerToolSnapshotInput): Promise<void>;
/** Arm the first ordinary Agent request immediately before `agent.followup()`. */
export declare function armMinimalPrimaryMutation(input: {
    taskId: string;
}): Promise<void>;
/** Record the exact `GenerateOptions.tools` presented to the DeepSeek adapter. */
export declare function recordMinimalAdapterRequest(input: AdapterRequestInput): Promise<{
    requestOrdinal: number;
    purpose: MinimalRequestPurpose;
}>;
/** Build a strict allowlist of request metadata safe to persist. */
export declare function buildRedactedRequestEnvelope(endpoint: string, body: Record<string, unknown>): RedactedRequestEnvelope;
/** Correlate one proxy request with the next adapter observation and compare all tool planes. */
export declare function claimMinimalWireRequest(taskId: string, envelope: RedactedRequestEnvelope): Promise<WireRequestClaim>;
/** Persist forced-policy telemetry atomically before the provider POST is allowed to begin. */
export declare function recordMinimalMutationPolicyApplication(input: {
    taskId: string;
    requestOrdinal: number;
    toolNames: readonly string[];
    policyVersion: string;
}): Promise<void>;
export declare function recordMinimalDiffObserved(taskId: string): Promise<void>;
/** Assert combinations that would otherwise recreate the R6.4 false state. */
export declare function assertMinimalRequestInvariant(task: TaskRecord): void;
export declare function isAuxiliaryPurpose(purpose: MinimalRequestPurpose): boolean;
export declare function isMutationPurpose(purpose: MinimalRequestPurpose): boolean;
