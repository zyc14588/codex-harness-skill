import type { InfrastructureFailureKind, SplitOutcomeAttribution, TaskRecord } from "./types.js";

export interface InfrastructureFailureDefinition {
  infrastructure: boolean;
  attemptAbort: boolean;
  retryable: boolean;
  attribution: SplitOutcomeAttribution;
}

/** Sole runtime taxonomy used by proxy, worker fail-fast and split memory. */
export const INFRASTRUCTURE_FAILURE_TAXONOMY: Readonly<Record<InfrastructureFailureKind, InfrastructureFailureDefinition>> = Object.freeze({
  tool_protocol: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  minimal_tool_plane: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  minimal_tool_plane_composition: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  minimal_tool_serialization_mismatch: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  thinking_policy_state: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  thinking_replay_state: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  provider_protocol: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  provider_transport: Object.freeze({ infrastructure: true, attemptAbort: false, retryable: true, attribution: "infrastructure" }),
  provider_credential: Object.freeze({ infrastructure: true, attemptAbort: true, retryable: false, attribution: "infrastructure" }),
  no_effect: Object.freeze({ infrastructure: true, attemptAbort: false, retryable: false, attribution: "infrastructure" }),
});

export const ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS = 422;

export function attemptInfrastructureAbortReason(
  task: Pick<TaskRecord, "infrastructureFailureKind" | "infrastructureFailureDetails">,
): string | undefined {
  const kind = task.infrastructureFailureKind;
  if (kind === undefined || !INFRASTRUCTURE_FAILURE_TAXONOMY[kind].attemptAbort) return undefined;
  return task.infrastructureFailureDetails ?? `${kind} requires the current execution attempt to stop`;
}

export function providerHttpFailureKind(status: number): Extract<InfrastructureFailureKind, "provider_protocol" | "provider_transport"> {
  return status === 408 || status === 429 || status >= 500 ? "provider_transport" : "provider_protocol";
}

export interface NormalizedProviderHttpFailure {
  kind: Extract<InfrastructureFailureKind, "provider_credential" | "provider_protocol" | "provider_transport">;
  category: "authentication" | "context_limit" | "output_limit" | "rate_limit" | "reasoning_replay" | "server" | "thinking_policy" | "tool_choice" | "invalid_request";
  details: string;
}

/** Persist only a bounded category, never an arbitrary Provider error body. */
export function normalizeProviderHttpFailure(status: number, body: Buffer): NormalizedProviderHttpFailure {
  const text = body.subarray(0, 64_000).toString("utf8").toLowerCase();
  let category: NormalizedProviderHttpFailure["category"];
  if (status === 401 || status === 403) category = "authentication";
  else if (status === 429) category = "rate_limit";
  else if (status >= 500 || status === 408) category = "server";
  else if (/reasoning[_ ]content|reasoning replay|tool-call history/u.test(text)) category = "reasoning_replay";
  else if (/tool[_ ]choice/u.test(text)) category = "tool_choice";
  else if (/thinking|reasoning[_ ]effort/u.test(text)) category = "thinking_policy";
  else if (/context|context window|prompt.{0,20}too (?:large|long)/u.test(text)) category = "context_limit";
  else if (/max[_ ](?:completion[_ ])?tokens|output.{0,20}(?:limit|too (?:large|long))/u.test(text)) category = "output_limit";
  else category = "invalid_request";
  const kind = category === "authentication"
    ? "provider_credential"
    : providerHttpFailureKind(status);
  return { kind, category, details: `Provider HTTP ${status} (${category})` };
}

export function infrastructureAnomalyLabels(task: Pick<TaskRecord, "infrastructureFailureKind">): string[] {
  const kind = task.infrastructureFailureKind;
  return kind !== undefined && INFRASTRUCTURE_FAILURE_TAXONOMY[kind].infrastructure ? [kind] : [];
}

export function failureAttribution(kind: InfrastructureFailureKind | undefined): SplitOutcomeAttribution | undefined {
  return kind === undefined ? undefined : INFRASTRUCTURE_FAILURE_TAXONOMY[kind].attribution;
}

/**
 * Normalize failures emitted before the managed minimal MCP tool plane can
 * publish its first runner snapshot. DSH currently wraps child-spawn and MCP
 * initialize/list failures in a generic preset-mount error, so relying only on
 * Bridge-authored MINIMAL_TOOL_* markers misattributes a zero-I/O startup
 * failure to the task shape.
 */
export function classifyMinimalToolPlaneFailure(
  task: Pick<TaskRecord, "executor" | "harnessMode">,
  details: string,
): Extract<InfrastructureFailureKind, "minimal_tool_plane_composition" | "minimal_tool_serialization_mismatch"> | undefined {
  if (task.executor !== "harness" || task.harnessMode !== "minimal") return undefined;
  if (/MINIMAL_TOOL_SERIALIZATION_MISMATCH:/u.test(details)) return "minimal_tool_serialization_mismatch";
  if (/MINIMAL_TOOL_(?:PLANE|PLANE_COMPOSITION):/u.test(details)) return "minimal_tool_plane_composition";

  const managedMcpEntry = /bridge-progressive-tools|mcp-client\(bridge\)|managed minimal preset Node command/iu.test(details);
  const startupFailure = /initial connection or tool synchroni[sz]ation failed|failed to mount|does not match the Bridge runtime/iu.test(details);
  return managedMcpEntry && startupFailure ? "minimal_tool_plane_composition" : undefined;
}
