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
    /** Provider and Adapter capabilities delivered over the launcher's anonymous stdin pipe. */
    capabilityInput: string;
    sandboxRoot: string;
    evidencePath: string;
}
export interface MinimalPresetBrokerInspection {
    ok: boolean;
    presetPath: string;
    trustedTemplatePath: string;
    expectedSha256?: string;
    configuredSha256?: string;
    errors: string[];
}
/** Verify the installed preset is the exact Bridge-owned in-process tool broker composition. */
export declare function inspectMinimalPresetBrokerComposition(presetDirectory: string, trustedTemplatePath?: string, profile?: string): Promise<MinimalPresetBrokerInspection>;
export declare function prepareHarnessSandbox(config: BridgeConfig, task: TaskRecord, launcher: HarnessLauncherIdentity, profile: string, selectedModel: string | undefined): Promise<PreparedHarnessSandbox>;
export declare function cleanupHarnessSandbox(sandboxRoot: string): Promise<void>;
