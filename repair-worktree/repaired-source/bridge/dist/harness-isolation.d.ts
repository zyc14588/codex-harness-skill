import type { BridgeConfig, TaskRecord } from "./types.js";
export interface HarnessLauncherIdentity {
    command: string;
    prefixArgs: string[];
    source: string;
}
export interface PreparedHarnessSandbox {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    sandboxRoot: string;
    evidencePath: string;
}
export declare function prepareHarnessSandbox(config: BridgeConfig, task: TaskRecord, launcher: HarnessLauncherIdentity, profile: string, selectedModel: string | undefined): Promise<PreparedHarnessSandbox>;
export declare function cleanupHarnessSandbox(sandboxRoot: string): Promise<void>;
