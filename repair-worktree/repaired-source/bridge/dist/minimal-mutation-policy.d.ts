import type { MinimalRequestPurpose, TaskRecord } from "./types.js";
export declare const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-attempt-fixed-v4";
export type MinimalMutationBypassKind = Extract<MinimalRequestPurpose, "session_title_auxiliary" | "compaction_auxiliary" | "pre_arm_auxiliary">;
export interface MinimalMutationPolicyResult {
    applied: boolean;
    body: Record<string, unknown>;
    toolNames: string[];
    reason?: string;
    bypassKind?: MinimalMutationBypassKind;
}
/**
 * DeepSeek V4 thinking mode can legally answer with free text even when tools
 * are present. For a bounded mutating minimal Flash leaf, that is not useful:
 * the controller requires a real repository diff before the leaf may finish.
 *
 * While the worktree still has no diff, the proxy narrows the visible catalog
 * to the built-in mutation tools, disables thinking for this request, and asks
 * the provider to return at least one structured tool call. Once any diff is
 * present, the full tool catalog is restored, but the attempt remains in
 * non-thinking mode. DeepSeek does not permit switching thinking mode while
 * replaying assistant tool-call history from the same attempt.
 *
 * Request purpose is supplied by the Bridge runner's adapter observation. The
 * proxy never guesses purpose from prompt text, max_tokens, or request shape.
 */
export declare function applyMinimalMutationPolicy(task: TaskRecord, requestBody: Record<string, unknown>, currentChangedPaths: readonly string[], model: string, purpose: MinimalRequestPurpose): MinimalMutationPolicyResult;
