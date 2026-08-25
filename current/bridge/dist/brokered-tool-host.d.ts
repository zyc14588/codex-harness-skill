import type { BridgeConfig, TaskRecord } from "./types.js";
export declare const MODEL_VISIBLE_TEXT_MAX_BYTES = 49152;
export declare const MODEL_VISIBLE_ESTIMATED_TOKEN_MAX = 12288;
export interface ModelVisibleTextPage {
    text: string;
    truncation: {
        encoding: "utf-8";
        sourceBytes: number;
        requestedOffsetBytes: number;
        offsetBytes: number;
        returnedBytes: number;
        estimatedTokens: number;
        maxBytes: number;
        maxEstimatedTokens: number;
        truncated: boolean;
        hasPrevious: boolean;
        nextOffsetBytes: number | null;
    };
}
/** Byte-accurate, UTF-8-safe model output page with explicit token estimation. */
export declare function modelVisibleTextPage(text: string, requestedOffsetBytes?: number, requestedMaxBytes?: number): ModelVisibleTextPage;
/** Unit-test seam for aggregate quota/rollback behavior; production calls remain broker-authorized through invoke(). */
export declare function editorForTest(task: TaskRecord, input: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function gitHistoryArguments(input: Record<string, unknown>): string[];
export interface BrokeredToolExecutionOptions {
    attemptId: string;
    signal: AbortSignal;
}
export declare function executeBrokeredTool(config: BridgeConfig, task: TaskRecord, tool: string, rawArguments: unknown, options: BrokeredToolExecutionOptions): Promise<unknown>;
