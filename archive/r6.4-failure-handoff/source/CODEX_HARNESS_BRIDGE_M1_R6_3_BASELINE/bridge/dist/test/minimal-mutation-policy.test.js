import assert from "node:assert/strict";
import test from "node:test";
import { applyMinimalMutationPolicy, MINIMAL_MUTATION_POLICY_VERSION } from "../minimal-mutation-policy.js";
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
const request = {
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
};
function requestToolNames(body) {
    return Array.isArray(body.tools)
        ? body.tools.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return [];
            const fn = raw.function;
            if (!fn || typeof fn !== "object" || Array.isArray(fn))
                return [];
            const name = fn.name;
            return typeof name === "string" ? [name] : [];
        })
        : [];
}
test("forces a first mutation tool call for a diff-free minimal Flash leaf", () => {
    const result = applyMinimalMutationPolicy(task, request, [], "deepseek-v4-flash");
    assert.equal(result.applied, true);
    assert.equal(result.reason, undefined);
    assert.equal(result.body.tool_choice, "required");
    assert.deepEqual(result.body.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in result.body, false);
    assert.deepEqual(requestToolNames(result.body), ["bash", "str_replace_editor"]);
    assert.deepEqual(result.toolNames, ["bash", "str_replace_editor"]);
    assert.equal(MINIMAL_MUTATION_POLICY_VERSION, "minimal-flash-required-v1");
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
test("fails preflight when no core mutation tool is disclosed", () => {
    const withoutCore = structuredClone(request);
    withoutCore.tools = [
        { type: "function", function: { name: "mcp__bridge__capability_catalog", description: "catalog", parameters: { type: "object" } } },
    ];
    const result = applyMinimalMutationPolicy(task, withoutCore, [], "deepseek-v4-flash");
    assert.equal(result.applied, false);
    assert.match(result.reason ?? "", /no disclosed core mutation tool/u);
});
//# sourceMappingURL=minimal-mutation-policy.test.js.map