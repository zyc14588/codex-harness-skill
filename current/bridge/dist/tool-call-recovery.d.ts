export type ToolProtocolRecoveryKind = "dsml_content_to_tool_calls" | "structured_tool_call_delta_normalized" | "markdown_shell_fence_to_tool_calls" | "text_tool_call_envelope_to_tool_calls";
export interface ToolProtocolTransformResult {
    body: Buffer;
    contentType: string;
    changed: boolean;
    recoveryKinds: ToolProtocolRecoveryKind[];
    recoveredToolNames: string[];
    /** Native structured calls observed without requiring recovery. */
    nativeToolCallCount?: number;
    nativeToolNames?: string[];
    /** A tool-call marker was present but could not be converted safely. */
    failure?: string;
}
interface RecoveredToolCall {
    name: string;
    arguments: string;
    id: string;
}
interface ParsedTextToolCalls {
    calls: RecoveredToolCall[];
    remainingText: string;
    markerFound: boolean;
    failure?: string;
}
export declare function allowedToolNamesFromRequest(body: Record<string, unknown>): Set<string>;
export declare function parseDsmlToolCalls(text: string, allowedNames: ReadonlySet<string>): ParsedTextToolCalls;
/**
 * Markdown shell recovery is deliberately narrower than DSML recovery. It is
 * only available for a Bridge-authored mutating leaf with at least one real
 * write lease. An exact standalone shell fence is then treated as a degraded
 * native tool call, including after earlier tool results when a task requires
 * more than one bounded command.
 */
export declare function isMutatingBoundedLeafRequest(body: Record<string, unknown>): boolean;
export declare function parseMarkdownShellToolCall(text: string, allowedNames: ReadonlySet<string>, requestBody: Record<string, unknown>): ParsedTextToolCalls;
/**
 * Recover only exact, whole-response textual tool-call envelopes. This covers
 * compatibility layers that serialize an OpenAI tool call into assistant text
 * instead of the structured `tool_calls` field. Ordinary prose and ordinary
 * JSON output are never executable: the payload must carry an explicit tool
 * call marker/name and the named tool must already be disclosed by the request.
 */
export declare function parseTextualToolCallEnvelope(text: string, allowedNames: ReadonlySet<string>, requestBody: Record<string, unknown>): ParsedTextToolCalls;
export declare function transformProviderToolCalls(contentType: string, body: Buffer, requestBody: Record<string, unknown>): ToolProtocolTransformResult;
export {};
