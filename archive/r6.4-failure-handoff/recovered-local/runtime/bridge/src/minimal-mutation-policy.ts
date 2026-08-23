import type { TaskRecord } from "./types.js";
import { allowedToolNamesFromRequest, isMutatingBoundedLeafRequest } from "./tool-call-recovery.js";

export const MINIMAL_MUTATION_POLICY_VERSION = "minimal-flash-required-v2";

export type MinimalMutationBypassKind = "session_title_auxiliary";

export interface MinimalMutationPolicyResult {
  applied: boolean;
  body: Record<string, unknown>;
  toolNames: string[];
  reason?: string;
  bypassKind?: MinimalMutationBypassKind;
}

const CORE_MUTATION_TOOLS = new Set(["bash", "pwsh", "str_replace_editor"]);
const SESSION_TITLE_SYSTEM_PREFIX = "Create a concise title for an AI coding-assistant session";

function toolName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fn = (raw as Record<string, unknown>).function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
    const record = entry as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
  }).join("\n");
}

/**
 * Harness' first-prompt title generator re-frames the complete human task inside
 * a JSON user message, so the bounded-leaf marker is present even though the
 * request is an auxiliary title call. The DeepSeek wire serializer intentionally
 * does not carry GenerateOptions.purpose, therefore the proxy recognizes the
 * title request from the exact Harness-owned system prefix plus its tool-less,
 * small-output request shape.
 */
export function isSessionTitleAuxiliaryRequest(requestBody: Record<string, unknown>): boolean {
  if (allowedToolNamesFromRequest(requestBody).size !== 0) return false;
  const maxTokens = requestBody.max_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 128) return false;
  const messages = requestBody.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const message = raw as Record<string, unknown>;
    return message.role === "system" && contentText(message.content).startsWith(SESSION_TITLE_SYSTEM_PREFIX);
  });
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
 *
 * Auxiliary title generation is explicitly bypassed. It contains the original
 * task text but deliberately has no tools; treating it as the mutation turn was
 * the R6.3 real-machine failure that raised minimal_tool_plane before the actual
 * Agent request reached the provider.
 */
export function applyMinimalMutationPolicy(
  task: TaskRecord,
  requestBody: Record<string, unknown>,
  currentChangedPaths: readonly string[],
  model: string,
): MinimalMutationPolicyResult {
  const executor = task.effectiveExecutor ?? task.executor;
  if (executor !== "harness" || task.harnessMode !== "minimal" || model !== "deepseek-v4-flash") {
    return { applied: false, body: requestBody, toolNames: [] };
  }
  if (isSessionTitleAuxiliaryRequest(requestBody)) {
    return {
      applied: false,
      body: requestBody,
      toolNames: [],
      bypassKind: "session_title_auxiliary",
    };
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
