import type { TaskRecord } from "./types.js";
export declare const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-required-v1";
export interface MinimalMutationPolicyResult {
    applied: boolean;
    body: Record<string, unknown>;
    toolNames: string[];
    reason?: string;
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
export declare function applyMinimalMutationPolicy(task: TaskRecord, requestBody: Record<string, unknown>, currentChangedPaths: readonly string[], model: string): MinimalMutationPolicyResult;
