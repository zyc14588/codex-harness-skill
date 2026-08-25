import type { BridgeConfig, TaskRecord } from "./types.js";
export type LlamaFailureCode = "disabled" | "budget" | "timeout" | "unavailable" | "process" | "http" | "invalid_output" | "security" | "resource";
export declare class LlamaExecutionError extends Error {
    readonly code: LlamaFailureCode;
    readonly fallbackEligible: boolean;
    constructor(code: LlamaFailureCode, message: string, fallbackEligible?: boolean);
}
export declare function managedLlamaServerStatus(config: BridgeConfig, includeProbe?: boolean): Promise<Record<string, unknown>>;
export declare function startManagedLlamaServer(config: BridgeConfig): Promise<Record<string, unknown>>;
export declare function stopManagedLlamaServer(config: BridgeConfig): Promise<Record<string, unknown>>;
export declare function probeLlamaCpp(config: BridgeConfig): Promise<Record<string, unknown>>;
export declare function runLlamaTask(config: BridgeConfig, task: TaskRecord): Promise<{
    summary: string;
    outputTokens: number;
    inputTokens: number;
}>;
