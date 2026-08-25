import type { BridgeConfig, FrozenHostResourceProfile, HostResourceLimits, HostResourceProfile, ResourceProfileId, TaskComplexity, WorkerExecutor } from "./types.js";
export interface ResourceWrappedCommand {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cgroupEnforced: boolean;
    rlimitsEnforced: true;
    unit?: string;
}
export declare const RESOURCE_PROFILE_IDS: ResourceProfileId[];
/** Exact, non-tunable Owner-approved DEC-003 limits. */
export declare const OWNER_RESOURCE_LIMITS: Readonly<Record<ResourceProfileId, Readonly<HostResourceLimits>>>;
export declare function ownerResourceProfileMatrix(): Record<ResourceProfileId, HostResourceLimits>;
export declare function resourceProfileHash(id: ResourceProfileId, limits: HostResourceLimits): string;
export declare function exactOwnerResourceLimits(id: ResourceProfileId, candidate: HostResourceLimits): void;
export declare function freezeHostResourceProfile(config: BridgeConfig, id: ResourceProfileId): FrozenHostResourceProfile;
export declare function selectResourceProfileId(executor: WorkerExecutor, model: string | undefined, complexity: TaskComplexity): ResourceProfileId;
export interface HostResourceProbe {
    ok: boolean;
    controlledUseAllowed: boolean;
    enforcement: HostResourceProfile["enforcement"];
    resourceProfileId?: ResourceProfileId;
    resourceProfileHash?: string;
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
export declare function resourceWrappedCommand(config: BridgeConfig, label: string, command: string, args: string[], selectedProfile?: HostResourceProfile): Promise<ResourceWrappedCommand>;
export declare function probeHostResourceProfile(config: BridgeConfig, selectedProfile?: HostResourceProfile): Promise<HostResourceProbe>;
export declare function assertControlledResourceProfile(config: BridgeConfig, selectedProfile?: HostResourceProfile): Promise<void>;
export declare function directoryAllocatedBytes(root: string): Promise<number>;
