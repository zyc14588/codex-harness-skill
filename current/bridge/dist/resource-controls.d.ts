import type { BridgeConfig, HostResourceProfile } from "./types.js";
export interface ResourceWrappedCommand {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cgroupEnforced: boolean;
    rlimitsEnforced: true;
    unit?: string;
}
export interface HostResourceProbe {
    ok: boolean;
    controlledUseAllowed: boolean;
    enforcement: HostResourceProfile["enforcement"];
    cgroupV2: boolean;
    memoryMax: boolean;
    cpuQuota: boolean;
    tasksMax: boolean;
    ioWeight: boolean;
    rlimitNoFile: boolean;
    rlimitNproc: boolean;
    rlimitFsize: boolean;
    observed?: Record<string, string>;
    error?: string;
}
/** Pin the host limit launchers and return the conservative release defaults. */
export declare function createPinnedHostResourceProfile(enforcement: HostResourceProfile["enforcement"]): Promise<HostResourceProfile>;
export declare function resourceWrappedCommand(config: BridgeConfig, label: string, command: string, args: string[]): Promise<ResourceWrappedCommand>;
export declare function probeHostResourceProfile(config: BridgeConfig): Promise<HostResourceProbe>;
export declare function assertControlledResourceProfile(config: BridgeConfig): Promise<void>;
export declare function directoryAllocatedBytes(root: string): Promise<number>;
