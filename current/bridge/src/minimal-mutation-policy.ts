import type { MinimalRequestPurpose, TaskRecord } from "./types.js";
import { allowedToolNamesFromRequest } from "./tool-call-recovery.js";

export const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-attempt-fixed-v4";

export type MinimalMutationBypassKind = Extract<MinimalRequestPurpose,
  "session_title_auxiliary" | "compaction_auxiliary" | "pre_arm_auxiliary">;

export interface MinimalMutationPolicyResult {
  applied: boolean;
  body: Record<string, unknown>;
  toolNames: string[];
  reason?: string;
  bypassKind?: MinimalMutationBypassKind;
}

const CORE_MUTATION_TOOLS = new Set(["bash", "pwsh", "str_replace_editor"]);

function toolName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fn = (raw as Record<string, unknown>).function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const name = (fn as Record<string, unknown>).name;
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
 * present, the full tool catalog is restored, but the attempt remains in
 * non-thinking mode. DeepSeek does not permit switching thinking mode while
 * replaying assistant tool-call history from the same attempt.
 *
 * Request purpose is supplied by the Bridge runner's adapter observation. The
 * proxy never guesses purpose from prompt text, max_tokens, or request shape.
 */
export function applyMinimalMutationPolicy(
  task: TaskRecord,
  requestBody: Record<string, unknown>,
  currentChangedPaths: readonly string[],
  model: string,
  purpose: MinimalRequestPurpose,
): MinimalMutationPolicyResult {
  const executor = task.effectiveExecutor ?? task.executor;
  if (executor !== "harness" || task.harnessMode !== "minimal" || model !== "deepseek-v4-flash") {
    return { applied: false, body: requestBody, toolNames: [] };
  }
  if (purpose === "session_title_auxiliary"
    || purpose === "compaction_auxiliary"
    || purpose === "pre_arm_auxiliary") {
    return {
      applied: false,
      body: requestBody,
      toolNames: [],
      bypassKind: purpose,
    };
  }
  if (purpose !== "primary_mutation" && purpose !== "mutation_followup") {
    return { applied: false, body: requestBody, toolNames: [] };
  }
  if (currentChangedPaths.length > 0) {
    const body: Record<string, unknown> = { ...requestBody };
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
    delete body.tool_choice;
    return { applied: false, body, toolNames: [] };
  }

  const disclosed = allowedToolNamesFromRequest(requestBody);
  const selected = [...disclosed].filter((name) => CORE_MUTATION_TOOLS.has(name)).sort();
  if (selected.length === 0) {
    return {
      applied: false,
      body: requestBody,
      toolNames: [],
      reason: disclosed.size === 0
        ? "minimal primary mutation request disclosed no tools"
        : "minimal mutating leaf has no disclosed core mutation tool",
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

  const body: Record<string, unknown> = { ...requestBody };
  body.tools = tools;
  body.tool_choice = "required";
  body.thinking = { type: "disabled" };
  delete body.reasoning_effort;
  return { applied: true, body, toolNames: selected };
}
