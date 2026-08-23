import type { BridgeConfig } from "./types.js";
export interface LiveUsageEstimate {
    requestId: string;
    taskId: string;
    budgetGroupId: string;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
    costUsd: number;
    updatedAt: string;
}
export declare function monitorBaseUrl(config: BridgeConfig): string;
export declare function pingMonitor(config: BridgeConfig): Promise<{
    ok: boolean;
    pid?: number;
    baseUrl: string;
    error?: string;
}>;
export declare function ensureMonitorRunning(config: BridgeConfig, configPath: string): Promise<{
    ok: boolean;
    pid?: number;
    baseUrl: string;
    started: boolean;
}>;
export declare function buildMonitorSnapshot(config: BridgeConfig, limit?: number, live?: LiveUsageEstimate[]): Promise<Record<string, unknown>>;
export declare function persistMonitorSnapshot(config: BridgeConfig, live?: LiveUsageEstimate[]): Promise<Record<string, unknown>>;
export declare function stopMonitor(config: BridgeConfig): Promise<{
    ok: boolean;
    stopped: boolean;
    pid?: number;
    baseUrl: string;
}>;
