import { allowedToolNamesFromRequest, isMutatingBoundedLeafRequest } from "./tool-call-recovery.js";
export const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-required-v1";
const CORE_MUTATION_TOOLS = new Set(["bash", "pwsh", "str_replace_editor"]);
function toolName(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const fn = raw.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn))
        return undefined;
    const name = fn.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
}
/**
 * DeepSeek V4 thinking mode can legally answer with free text even when tools
 * are present. For a bounded mutating minimal Flash leaf, that is not useful:
 * the controller requires a real repository diff before the leaf may finish.
 *
 * While the worktree still has no diff, the proxy narrows the visible catalog
 * to the built-in mutation tools, disables thinking for this request, and asks
 * the provider to return at least one structured tool call. Once any diff is
 * present, the original request shape is restored so Harness can test and
 * summarize normally.
 */
export function applyMinimalMutationPolicy(task, requestBody, currentChangedPaths, model) {
    const executor = task.effectiveExecutor ?? task.executor;
    if (executor !== "harness" || task.harnessMode !== "minimal" || model !== "deepseek-v4-flash") {
        return { applied: false, body: requestBody, toolNames: [] };
    }
    if (!isMutatingBoundedLeafRequest(requestBody)) {
        return { applied: false, body: requestBody, toolNames: [] };
    }
    if (currentChangedPaths.length > 0) {
        return { applied: false, body: requestBody, toolNames: [] };
    }
    const disclosed = allowedToolNamesFromRequest(requestBody);
    const selected = [...disclosed].filter((name) => CORE_MUTATION_TOOLS.has(name)).sort();
    if (selected.length === 0) {
        return {
            applied: false,
            body: requestBody,
            toolNames: [],
            reason: "minimal mutating leaf has no disclosed core mutation tool",
        };
    }
    const tools = Array.isArray(requestBody.tools)
        ? requestBody.tools.filter((raw) => {
            const name = toolName(raw);
            return name !== undefined && selected.includes(name);
        })
        : [];
    if (tools.length === 0) {
        return {
            applied: false,
            body: requestBody,
            toolNames: [],
            reason: "minimal mutating leaf tool catalog could not be narrowed safely",
        };
    }
    const body = { ...requestBody };
    body.tools = tools;
    body.tool_choice = "required";
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
    return { applied: true, body, toolNames: selected };
}
//# sourceMappingURL=minimal-mutation-policy.js.map