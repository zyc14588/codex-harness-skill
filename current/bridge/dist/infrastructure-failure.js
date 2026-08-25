/** Sole runtime taxonomy used by proxy, worker fail-fast and split memory. */
export const INFRASTRUCTURE_FAILURE_TAXONOMY = Object.freeze({
    tool_protocol: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    minimal_tool_plane: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    minimal_tool_plane_composition: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    minimal_tool_serialization_mismatch: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    thinking_policy_state: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    thinking_replay_state: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    provider_protocol: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    provider_transport: Object.freeze({ infrastructure: true, attemptAbort: false, retryable: true, attribution: "infrastructure" }),
    provider_credential: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    resource_control: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
    no_effect: Object.freeze({ infrastructure: true, attemptAbort: false, retryable: false, attribution: "infrastructure" }),
});
export const ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS = 422;
export function attemptInfrastructureAbortReason(task) {
    const kind = task.infrastructureFailureKind;
    if (kind === undefined || !INFRASTRUCTURE_FAILURE_TAXONOMY[kind].attemptAbort)
        return undefined;
    return task.infrastructureFailureDetails ?? `${kind} requires the current execution attempt to stop`;
}
export function providerHttpFailureKind(status) {
    return status === 408 || status === 429 || status >= 500 ? "provider_transport" : "provider_protocol";
}
/** Persist only a bounded category, never an arbitrary Provider error body. */
export function normalizeProviderHttpFailure(status, body) {
    const text = body.subarray(0, 64_000).toString("utf8").toLowerCase();
    let category;
    if (status === 401 || status === 403)
        category = "authentication";
    else if (status === 429)
        category = "rate_limit";
    else if (status >= 500 || status === 408)
        category = "server";
    else if (/reasoning[_ ]content|reasoning replay|tool-call history/u.test(text))
        category = "reasoning_replay";
    else if (/tool[_ ]choice/u.test(text))
        category = "tool_choice";
    else if (/thinking|reasoning[_ ]effort/u.test(text))
        category = "thinking_policy";
    else if (/context|context window|prompt.{0,20}too (?:large|long)/u.test(text))
        category = "context_limit";
    else if (/max[_ ](?:completion[_ ])?tokens|output.{0,20}(?:limit|too (?:large|long))/u.test(text))
        category = "output_limit";
    else
        category = "invalid_request";
    const kind = category === "authentication"
        ? "provider_credential"
        : providerHttpFailureKind(status);
    return { kind, category, details: `Provider HTTP ${status} (${category})` };
}
export function infrastructureAnomalyLabels(task) {
    const kind = task.infrastructureFailureKind;
    return kind !== undefined && INFRASTRUCTURE_FAILURE_TAXONOMY[kind].infrastructure ? [kind] : [];
}
export function failureAttribution(kind) {
    return kind === undefined ? undefined : INFRASTRUCTURE_FAILURE_TAXONOMY[kind].attribution;
}
/** Classify fail-closed host/controller/quota failures so split memory never blames task shape. */
export function classifyResourceControlFailure(details) {
    return /(?:controlled Harness execution requires verified cgroup v2 and RLIMIT controls|resource profile .*?(?:mismatch|approved value)|resource ceiling|aggregate worktree quota|cgroup|MemoryMax|CPUQuota|TasksMax|IOWeight|RLIMIT_|prlimit SHA-256 mismatch|systemd-run SHA-256 mismatch|untrusted user-systemd)/iu.test(details)
        ? "resource_control"
        : undefined;
}
/**
 * Normalize failures emitted before the managed in-process broker tool plane
 * can publish its first runner snapshot. Relying only on Bridge-authored
 * MINIMAL_TOOL_* markers can misattribute a zero-I/O preset/plugin startup
 * failure to the task shape.
 */
export function classifyMinimalToolPlaneFailure(task, details) {
    if (task.executor !== "harness" || task.harnessMode !== "minimal")
        return undefined;
    if (/MINIMAL_TOOL_SERIALIZATION_MISMATCH:/u.test(details))
        return "minimal_tool_serialization_mismatch";
    if (/MINIMAL_TOOL_(?:PLANE|PLANE_COMPOSITION):/u.test(details))
        return "minimal_tool_plane_composition";
    const managedBrokerEntry = /bridge-brokered-tools|codex-bridge-brokered-tools|brokered tool capability/iu.test(details);
    const startupFailure = /failed to mount|failed to apply loader entry|differs from the release-bundled trusted template|capability is unavailable/iu.test(details);
    return managedBrokerEntry && startupFailure ? "minimal_tool_plane_composition" : undefined;
}
//# sourceMappingURL=infrastructure-failure.js.map