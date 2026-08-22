import type { TaskRecord } from "./types.js";
export declare const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-required-v2";
export type MinimalMutationBypassKind = "session_title_auxiliary";
export interface MinimalMutationPolicyResult {
    applied: boolean;
    body: Record<string, unknown>;
    toolNames: string[];
    reason?: string;
    bypassKind?: MinimalMutationBypassKind;
}
/**
 * Harness' first-prompt title generator re-frames the complete human task inside
 * a JSON user message, so the bounded-leaf marker is present even though the
 * request is an auxiliary title call. The DeepSeek wire serializer intentionally
 * does not carry GenerateOptions.purpose, therefore the proxy recognizes the
 * title request from the exact Harness-owned system prefix plus its tool-less,
 * small-output request shape.
 */
export declare function isSessionTitleAuxiliaryRequest(requestBody: Record<string, unknown>): boolean;
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
 *
 * Auxiliary title generation is explicitly bypassed. It contains the original
 * task text but deliberately has no tools; treating it as the mutation turn was
 * the R6.3 real-machine failure that raised minimal_tool_plane before the actual
 * Agent request reached the provider.
 */
export declare function applyMinimalMutationPolicy(task: TaskRecord, requestBody: Record<string, unknown>, currentChangedPaths: readonly string[], model: string): MinimalMutationPolicyResult;
