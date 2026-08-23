import { createHash, randomUUID } from "node:crypto";
import type {
  AttemptThinkingPolicy,
  ExecutionAttempt,
  ReasoningReplayRequirement,
  TaskRecord,
  ThinkingRequestEvidence,
} from "./types.js";

export const ATTEMPT_THINKING_POLICY_VERSION = "attempt-thinking-policy-v1" as const;

const MAX_THINKING_EVIDENCE = 128;

export function thinkingPolicyForModel(model: string, frozenAt: string): AttemptThinkingPolicy | undefined {
  if (model === "deepseek-v4-flash") {
    return {
      schemaVersion: 1,
      policyVersion: ATTEMPT_THINKING_POLICY_VERSION,
      model,
      thinkingType: "disabled",
      reasoningEffort: "off",
      frozenAt,
    };
  }
  if (model === "deepseek-v4-pro") {
    return {
      schemaVersion: 1,
      policyVersion: ATTEMPT_THINKING_POLICY_VERSION,
      model,
      thinkingType: "enabled",
      reasoningEffort: "high",
      frozenAt,
    };
  }
  return undefined;
}

/** Build a new attempt with its DeepSeek mode frozen before the process starts. */
export function createExecutionAttempt(
  executor: ExecutionAttempt["executor"],
  model: string | undefined,
  ordinal: number,
  startedAt: string,
): ExecutionAttempt {
  const value: ExecutionAttempt = {
    id: randomUUID(),
    ordinal,
    executor,
    startedAt,
  };
  if (model !== undefined) {
    value.model = model;
    const policy = executor === "harness" ? thinkingPolicyForModel(model, startedAt) : undefined;
    if (policy !== undefined) value.thinkingPolicy = policy;
  }
  return value;
}

/**
 * Backward-compatible lazy freeze for queued records created by an older
 * Bridge. The freeze still happens before the first Provider request.
 */
export function ensureAttemptThinkingPolicy(task: TaskRecord, model: string, frozenAt: string): string | undefined {
  const attempt = task.executionAttempts?.at(-1);
  if (attempt === undefined || attempt.executor !== "harness" || attempt.completedAt !== undefined) {
    return "active Harness execution attempt is missing";
  }
  attempt.id ??= randomUUID();
  attempt.ordinal ??= task.executionAttempts?.length ?? 1;
  if (attempt.model !== undefined && attempt.model !== model) {
    return `attempt model is immutable (${attempt.model}); request selected ${model}`;
  }
  const expected = thinkingPolicyForModel(model, frozenAt);
  if (expected === undefined) return `no immutable thinking policy exists for model ${model}`;
  if (attempt.thinkingPolicy === undefined) {
    attempt.model = model;
    attempt.thinkingPolicy = expected;
    return undefined;
  }
  const current = attempt.thinkingPolicy;
  if (current.schemaVersion !== 1
    || current.policyVersion !== ATTEMPT_THINKING_POLICY_VERSION
    || current.model !== expected.model
    || current.thinkingType !== expected.thinkingType
    || current.reasoningEffort !== expected.reasoningEffort) {
    return "attempt thinking policy changed after it was frozen";
  }
  return undefined;
}

function thinkingType(body: Record<string, unknown>): string | undefined {
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return undefined;
  const value = (thinking as Record<string, unknown>).type;
  return typeof value === "string" ? value : undefined;
}

function toolCallIds(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return [...new Set(message.tool_calls.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = (raw as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  }))].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ReplayValidation {
  ok: boolean;
  replayedRequirementOrdinals: number[];
  message?: string;
}

export function validateReasoningReplay(
  messages: unknown,
  requirements: readonly ReasoningReplayRequirement[],
): ReplayValidation {
  if (requirements.length === 0) return { ok: true, replayedRequirementOrdinals: [] };
  const assistantToolMessages = Array.isArray(messages)
    ? messages.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const message = raw as Record<string, unknown>;
      return message.role === "assistant" && toolCallIds(message).length > 0 ? [message] : [];
    })
    : [];
  const replayed: number[] = [];
  for (const requirement of requirements) {
    const expectedIds = [...requirement.toolCallIds].sort();
    const message = assistantToolMessages.find((candidate) => {
      const actualIds = toolCallIds(candidate);
      return expectedIds.length === actualIds.length
        && expectedIds.every((id, index) => id === actualIds[index]);
    });
    if (message === undefined) {
      return {
        ok: false,
        replayedRequirementOrdinals: replayed,
        message: `assistant tool-call history for Provider request ${requirement.responseRequestOrdinal} is missing`,
      };
    }
    const reasoning = message.reasoning_content;
    if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
      return {
        ok: false,
        replayedRequirementOrdinals: replayed,
        message: `reasoning_content replay for Provider request ${requirement.responseRequestOrdinal} is missing or empty`,
      };
    }
    const bytes = Buffer.byteLength(reasoning, "utf8");
    if (bytes !== requirement.reasoningUtf8Bytes || sha256(reasoning) !== requirement.reasoningSha256) {
      return {
        ok: false,
        replayedRequirementOrdinals: replayed,
        message: `reasoning_content replay for Provider request ${requirement.responseRequestOrdinal} does not match the Provider response`,
      };
    }
    replayed.push(requirement.responseRequestOrdinal);
  }
  return { ok: true, replayedRequirementOrdinals: replayed };
}

export type ThinkingRequestPreflight =
  | {
    ok: true;
    attempt: ExecutionAttempt & { id: string; thinkingPolicy: AttemptThinkingPolicy };
    evidence: ThinkingRequestEvidence;
  }
  | {
    ok: false;
    kind: "thinking_policy_state" | "thinking_replay_state";
    message: string;
  };

/** Validate the final wire shape. This function never repairs a mode switch. */
export function preflightThinkingRequest(
  task: TaskRecord,
  body: Record<string, unknown>,
  model: string,
  providerSentAt: string,
): ThinkingRequestPreflight {
  const attempt = task.executionAttempts?.at(-1);
  if (attempt?.id === undefined || attempt.thinkingPolicy === undefined) {
    return { ok: false, kind: "thinking_policy_state", message: "attempt thinking policy was not frozen" };
  }
  const policy = attempt.thinkingPolicy;
  if (attempt.completedAt !== undefined || attempt.executor !== "harness") {
    return { ok: false, kind: "thinking_policy_state", message: "Provider request is not owned by an active Harness attempt" };
  }
  if (model !== policy.model || (attempt.model !== undefined && attempt.model !== model)) {
    return { ok: false, kind: "thinking_policy_state", message: `request model ${model} differs from frozen attempt model ${policy.model}` };
  }
  const actualThinking = thinkingType(body);
  if (actualThinking !== policy.thinkingType) {
    return {
      ok: false,
      kind: "thinking_policy_state",
      message: `request thinking.type ${actualThinking ?? "missing"} differs from frozen ${policy.thinkingType} policy`,
    };
  }
  const reasoningEffortPresent = Object.prototype.hasOwnProperty.call(body, "reasoning_effort");
  const actualReasoningEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  if (policy.thinkingType === "disabled" && reasoningEffortPresent) {
    return { ok: false, kind: "thinking_policy_state", message: "disabled thinking request must omit reasoning_effort" };
  }
  if (policy.thinkingType === "enabled" && actualReasoningEffort !== policy.reasoningEffort) {
    return {
      ok: false,
      kind: "thinking_policy_state",
      message: `enabled thinking request must retain frozen reasoning_effort=${policy.reasoningEffort}`,
    };
  }
  const toolChoicePresent = Object.prototype.hasOwnProperty.call(body, "tool_choice");
  if (policy.thinkingType === "enabled" && toolChoicePresent) {
    return { ok: false, kind: "thinking_policy_state", message: "enabled thinking request must omit tool_choice" };
  }
  const requirements = (task.reasoningReplayRequirements ?? [])
    .filter((requirement) => requirement.attemptId === attempt.id);
  const replay = validateReasoningReplay(body.messages, requirements);
  if (!replay.ok) {
    return { ok: false, kind: "thinking_replay_state", message: replay.message ?? "reasoning replay validation failed" };
  }
  const requestOrdinal = (task.providerRequestOrdinal ?? 0) + 1;
  const evidence: ThinkingRequestEvidence = {
    requestOrdinal,
    attemptId: attempt.id,
    model,
    thinkingType: policy.thinkingType,
    ...(actualReasoningEffort === undefined ? {} : { reasoningEffort: actualReasoningEffort }),
    toolChoicePresent,
    replayRequirementCount: requirements.length,
    replayedRequirementOrdinals: replay.replayedRequirementOrdinals,
    providerSentAt,
  };
  return { ok: true, attempt: attempt as ExecutionAttempt & { id: string; thinkingPolicy: AttemptThinkingPolicy }, evidence };
}

function responsePackets(contentType: string, capture: Buffer): Record<string, unknown>[] {
  const text = capture.toString("utf8");
  if (contentType.includes("text/event-stream") || text.startsWith("data:")) {
    const packets: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const value = JSON.parse(data) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) packets.push(value as Record<string, unknown>);
      } catch { /* a malformed Provider stream is handled by the normal protocol path */ }
    }
    return packets;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
  } catch { return []; }
}

function firstChoicePayload(packet: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(packet.choices)) return undefined;
  const choice = packet.choices.find((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const index = (raw as Record<string, unknown>).index;
    return index === undefined || index === 0;
  });
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return undefined;
  const record = choice as Record<string, unknown>;
  const payload = record.delta ?? record.message;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
}

export type ReasoningCaptureResult =
  | { ok: true; requirement?: ReasoningReplayRequirement }
  | { ok: false; message: string };

/** Derive replay integrity metadata from the exact response sent to Harness. */
export function captureReasoningRequirement(
  contentType: string,
  capture: Buffer,
  attemptId: string,
  responseRequestOrdinal: number,
  recordedAt: string,
): ReasoningCaptureResult {
  let reasoning = "";
  const ids = new Set<string>();
  let sawToolCallWithoutId = false;
  for (const packet of responsePackets(contentType, capture)) {
    const payload = firstChoicePayload(packet);
    if (payload === undefined) continue;
    if (typeof payload.reasoning_content === "string") reasoning += payload.reasoning_content;
    if (!Array.isArray(payload.tool_calls)) continue;
    for (const raw of payload.tool_calls) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const id = (raw as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) ids.add(id);
      else sawToolCallWithoutId = true;
    }
  }
  if (ids.size === 0 && !sawToolCallWithoutId) return { ok: true };
  if (sawToolCallWithoutId && ids.size === 0) {
    return { ok: false, message: "enabled-thinking Provider tool call omitted its replay identity" };
  }
  if (reasoning.trim().length === 0) {
    return { ok: false, message: "enabled-thinking Provider tool call omitted non-empty reasoning_content" };
  }
  return {
    ok: true,
    requirement: {
      schemaVersion: 1,
      attemptId,
      responseRequestOrdinal,
      reasoningSha256: sha256(reasoning),
      reasoningUtf8Bytes: Buffer.byteLength(reasoning, "utf8"),
      toolCallIds: [...ids].sort(),
      recordedAt,
      replayCount: 0,
    },
  };
}

export function appendThinkingEvidence(task: TaskRecord, evidence: ThinkingRequestEvidence): void {
  task.providerRequestOrdinal = evidence.requestOrdinal;
  task.thinkingRequestEvidence = [...(task.thinkingRequestEvidence ?? []), evidence].slice(-MAX_THINKING_EVIDENCE);
  const minimal = task.minimalRequestEvidence?.find((entry) => entry.requestOrdinal === evidence.requestOrdinal);
  if (minimal !== undefined) {
    minimal.providerThinkingType = evidence.thinkingType;
    if (evidence.reasoningEffort !== undefined) minimal.providerReasoningEffort = evidence.reasoningEffort;
    else delete minimal.providerReasoningEffort;
    minimal.providerToolChoicePresent = evidence.toolChoicePresent;
    minimal.providerSentAt = evidence.providerSentAt;
  }
  for (const ordinal of evidence.replayedRequirementOrdinals) {
    const requirement = task.reasoningReplayRequirements?.find((candidate) => (
      candidate.attemptId === evidence.attemptId && candidate.responseRequestOrdinal === ordinal
    ));
    if (requirement !== undefined) {
      requirement.replayCount += 1;
      requirement.lastReplayedAt = evidence.providerSentAt;
      requirement.lastReplayRequestOrdinal = evidence.requestOrdinal;
    }
  }
}
