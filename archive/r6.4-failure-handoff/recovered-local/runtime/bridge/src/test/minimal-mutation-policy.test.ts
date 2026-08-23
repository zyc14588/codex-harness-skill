import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMinimalMutationPolicy,
  isSessionTitleAuxiliaryRequest,
  MINIMAL_MUTATION_POLICY_VERSION,
} from "../minimal-mutation-policy.js";
import type { TaskRecord } from "../types.js";

const contract = `# CODEX-HARNESS BOUNDED LEAF CONTRACT

Task ID: forced-mutation
Mode: implementation

## Objective
Create probe.json

## Harness exclusive write leases
- probe.json

## Acceptance criteria
- probe.json exists
`;

const request: Record<string, unknown> = {
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: contract }],
  thinking: { type: "enabled" },
  reasoning_effort: "high",
  tool_choice: "auto",
  tools: [
    { type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } },
    { type: "function", function: { name: "str_replace_editor", description: "edit", parameters: { type: "object" } } },
    { type: "function", function: { name: "mcp__bridge__capability_catalog", description: "catalog", parameters: { type: "object" } } },
  ],
};

const task = {
  executor: "harness",
  effectiveExecutor: "harness",
  harnessMode: "minimal",
} as TaskRecord;

function requestToolNames(body: Record<string, unknown>): string[] {
  return Array.isArray(body.tools)
    ? body.tools.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const fn = (raw as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) return [];
      const name = (fn as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    })
    : [];
}

test("forces a first mutation tool call for a diff-free minimal Flash leaf", () => {
  const result = applyMinimalMutationPolicy(task, request, [], "deepseek-v4-flash");
  assert.equal(result.applied, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.bypassKind, undefined);
  assert.equal(result.body.tool_choice, "required");
  assert.deepEqual(result.body.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in result.body, false);
  assert.deepEqual(requestToolNames(result.body), ["bash", "str_replace_editor"]);
  assert.deepEqual(result.toolNames, ["bash", "str_replace_editor"]);
  assert.equal(MINIMAL_MUTATION_POLICY_VERSION, "minimal-flash-required-v2");
});

test("restores the ordinary request shape after a real diff exists", () => {
  const result = applyMinimalMutationPolicy(task, request, ["probe.json"], "deepseek-v4-flash");
  assert.equal(result.applied, false);
  assert.equal(result.body, request);
});

test("does not force Pro, standard, or non-mutating tasks", () => {
  assert.equal(applyMinimalMutationPolicy(task, request, [], "deepseek-v4-pro").applied, false);
  assert.equal(applyMinimalMutationPolicy({ ...task, harnessMode: "standard" }, request, [], "deepseek-v4-flash").applied, false);
  const analysis = structuredClone(request);
  analysis.messages = [{ role: "user", content: contract.replace("Mode: implementation", "Mode: analysis") }];
  assert.equal(applyMinimalMutationPolicy(task, analysis, [], "deepseek-v4-flash").applied, false);
});

test("bypasses the Harness first-prompt title request even though it embeds the bounded contract", () => {
  const titleRequest: Record<string, unknown> = {
    model: "deepseek-v4-flash",
    messages: [
      {
        role: "system",
        content: "Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title.",
      },
      {
        role: "user",
        content: `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: 1, content: contract }])}`,
      },
    ],
    thinking: { type: "disabled" },
    max_tokens: 64,
    stream: true,
  };
  assert.equal(isSessionTitleAuxiliaryRequest(titleRequest), true);
  const result = applyMinimalMutationPolicy(task, titleRequest, [], "deepseek-v4-flash");
  assert.equal(result.applied, false);
  assert.equal(result.reason, undefined);
  assert.equal(result.bypassKind, "session_title_auxiliary");
  assert.equal(result.body, titleRequest);
});

test("still fails a primary request that advertises tools but omits every core mutation tool", () => {
  const withoutCore = structuredClone(request);
  withoutCore.tools = [
    { type: "function", function: { name: "mcp__bridge__capability_catalog", description: "catalog", parameters: { type: "object" } } },
  ];
  const result = applyMinimalMutationPolicy(task, withoutCore, [], "deepseek-v4-flash");
  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /no disclosed core mutation tool/u);
});

test("fails an unrecognized tool-less primary mutation request instead of silently bypassing it", () => {
  const noTools = structuredClone(request);
  delete noTools.tools;
  const result = applyMinimalMutationPolicy(task, noTools, [], "deepseek-v4-flash");
  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /disclosed no tools/u);
  assert.equal(result.bypassKind, undefined);
});
