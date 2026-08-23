import type { BridgeConfig, LlamaCppConfig, TaskBudget } from "./types.js";
export declare const LATEST_HARNESS_FALLBACK_MODEL: "deepseek-v4-flash";
export declare const DEEPSEEK_PRO_MODEL: "deepseek-v4-pro";
export declare const DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash";
export declare const DEFAULT_BUDGET: TaskBudget;
export declare const MAXIMUM_BUDGET: TaskBudget;
export declare const DEFAULT_PRO_COMPLEX_BUDGET: TaskBudget;
export declare function normalizeTaskBudget(value: unknown, fallback: TaskBudget, field: string): TaskBudget;
export declare function budgetWithin(value: TaskBudget, maximum: TaskBudget): boolean;
export declare function assertLoopbackHost(host: string, field: string): void;
export declare function normalizeLlamaConfig(value: unknown, fallback?: LlamaCppConfig): LlamaCppConfig;
export declare function defaultConfigPath(): string;
export declare function loadConfig(): Promise<BridgeConfig>;
export declare function resolveHarnessLauncher(config: BridgeConfig): Promise<{
    command: string;
    prefixArgs: string[];
    source: string;
}>;
export declare function sanitizedEnvironment(config: BridgeConfig): NodeJS.ProcessEnv;
