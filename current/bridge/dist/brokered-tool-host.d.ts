import type { BridgeConfig, TaskRecord } from "./types.js";
export declare function executeBrokeredTool(config: BridgeConfig, task: TaskRecord, tool: string, rawArguments: unknown): Promise<unknown>;
