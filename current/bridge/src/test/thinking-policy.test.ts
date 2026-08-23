import assert from "node:assert/strict";
import test from "node:test";
import {
  appendThinkingEvidence,
  captureReasoningRequirement,
  createExecutionAttempt,
  ensureAttemptThinkingPolicy,
  preflightThinkingRequest,
  thinkingPolicyForModel,
} from "../thinking-policy.js";
import type { TaskRecord } from "../types.js";

function task(model: "deepseek-v4-flash" | "deepseek-v4-pro"): TaskRecord {
  return {
    executor: "harness",
    effectiveExecutor: "harness",
    executionAttempts: [createExecutionAttempt("harness", model, 1, "2026-08-22T00:00:00.000Z")],
    providerRequestOrdinal: 0,
  } as TaskRecord;
}

function proRequest(messages: unknown[] = [{ role: "user", content: "perform the bounded task" }]): Record<string, unknown> {
  return {
    model: "deepseek-v4-pro",
    messages,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
  };
}

test("freezes exact Flash and Pro thinking policies per execution attempt", () => {
  assert.deepEqual(thinkingPolicyForModel("deepseek-v4-flash", "t"), {
    schemaVersion: 1,
    policyVersion: "attempt-thinking-policy-v1",
    model: "deepseek-v4-flash",
    thinkingType: "disabled",
    reasoningEffort: "off",
    frozenAt: "t",
  });
  assert.deepEqual(thinkingPolicyForModel("deepseek-v4-pro", "t"), {
    schemaVersion: 1,
    policyVersion: "attempt-thinking-policy-v1",
    model: "deepseek-v4-pro",
    thinkingType: "enabled",
    reasoningEffort: "high",
    frozenAt: "t",
  });
  assert.equal(thinkingPolicyForModel("unknown", "t"), undefined);
});

test("accepts only disabled Flash wire requests with reasoning_effort omitted", () => {
  const current = task("deepseek-v4-flash");
  const valid = preflightThinkingRequest(current, {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "task" }],
    thinking: { type: "disabled" },
  }, "deepseek-v4-flash", "2026-08-22T00:00:01.000Z");
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.evidence.thinkingType, "disabled");
  assert.equal(valid.evidence.reasoningEffort, undefined);

  for (const invalid of [
    { thinking: { type: "enabled" } },
    { thinking: { type: "disabled" }, reasoning_effort: "off" },
    { thinking: { type: "disabled" }, reasoning_effort: "high" },
  ]) {
    const result = preflightThinkingRequest(current, {
      model: "deepseek-v4-flash",
      messages: [],
      ...invalid,
    }, "deepseek-v4-flash", "2026-08-22T00:00:01.000Z");
    assert.deepEqual(result.ok ? undefined : result.kind, "thinking_policy_state");
  }
});

test("rejects Pro mode switching and tool_choice before Provider I/O", () => {
  const current = task("deepseek-v4-pro");
  assert.equal(preflightThinkingRequest(
    current,
    proRequest(),
    "deepseek-v4-pro",
    "2026-08-22T00:00:01.000Z",
  ).ok, true);
  for (const patch of [
    { thinking: { type: "disabled" }, reasoning_effort: undefined },
    { thinking: { type: "enabled" }, reasoning_effort: "low" },
    { thinking: { type: "enabled" }, reasoning_effort: "high", tool_choice: "auto" },
  ]) {
    const request: Record<string, unknown> = { ...proRequest(), ...patch };
    if (patch.reasoning_effort === undefined) delete request.reasoning_effort;
    const result = preflightThinkingRequest(current, request, "deepseek-v4-pro", "2026-08-22T00:00:01.000Z");
    assert.deepEqual(result.ok ? undefined : result.kind, "thinking_policy_state");
  }
});

test("captures real Pro reasoning integrity and requires exact full-history replay", () => {
  const current = task("deepseek-v4-pro");
  const first = preflightThinkingRequest(current, proRequest(), "deepseek-v4-pro", "2026-08-22T00:00:01.000Z");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  appendThinkingEvidence(current, first.evidence);

  const reasoning = "Provider-owned analysis: inspect then update the leased file.";
  const capture = Buffer.from([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "Provider-owned analysis: inspect " }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "then update the leased file." }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-real-1", type: "function", function: { name: "bash", arguments: "{}" } }] }, finish_reason: null }] })}`,
    "data: [DONE]",
    "",
  ].join("\n"));
  const captured = captureReasoningRequirement(
    "text/event-stream",
    capture,
    first.evidence.attemptId,
    first.evidence.requestOrdinal,
    "2026-08-22T00:00:02.000Z",
  );
  assert.equal(captured.ok, true);
  if (!captured.ok || captured.requirement === undefined) return;
  assert.equal(captured.requirement.reasoningUtf8Bytes, Buffer.byteLength(reasoning));
  assert.equal(JSON.stringify(captured.requirement).includes(reasoning), false, "reasoning text must not be persisted");
  current.reasoningReplayRequirements = [captured.requirement];

  const history = [
    { role: "user", content: "perform the bounded task" },
    {
      role: "assistant",
      content: "",
      reasoning_content: reasoning,
      tool_calls: [{ id: "call-real-1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call-real-1", content: "ok" },
  ];
  const replay = preflightThinkingRequest(current, proRequest(history), "deepseek-v4-pro", "2026-08-22T00:00:03.000Z");
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.deepEqual(replay.evidence.replayedRequirementOrdinals, [1]);
  appendThinkingEvidence(current, replay.evidence);
  assert.equal(current.reasoningReplayRequirements[0]?.replayCount, 1);
  assert.equal(current.reasoningReplayRequirements[0]?.lastReplayRequestOrdinal, 2);

  for (const invalidHistory of [
    history.filter((message) => message.role !== "assistant"),
    history.map((message) => message.role === "assistant" ? { ...message, reasoning_content: "" } : message),
    history.map((message) => message.role === "assistant" ? { ...message, reasoning_content: `${reasoning}tampered` } : message),
  ]) {
    const rejected = preflightThinkingRequest(current, proRequest(invalidHistory), "deepseek-v4-pro", "2026-08-22T00:00:04.000Z");
    assert.deepEqual(rejected.ok ? undefined : rejected.kind, "thinking_replay_state");
  }
});

test("classifies a Pro tool-call response without reasoning_content as Provider protocol failure", () => {
  const capture = Buffer.from(`${JSON.stringify({
    choices: [{ index: 0, message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-no-reasoning", type: "function", function: { name: "bash", arguments: "{}" } }],
    } }],
  })}\n`);
  const result = captureReasoningRequirement("application/json", capture, "attempt", 1, "now");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /omitted non-empty reasoning_content/u);
});

test("refuses a model change after an attempt policy is frozen", () => {
  const current = task("deepseek-v4-flash");
  const message = ensureAttemptThinkingPolicy(current, "deepseek-v4-pro", "later");
  assert.match(message ?? "", /attempt model is immutable/u);
  assert.equal(current.executionAttempts?.[0]?.thinkingPolicy?.model, "deepseek-v4-flash");
});
