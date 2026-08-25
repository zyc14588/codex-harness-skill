import type { BridgeConfig, FrozenHostResourceProfile, ProcessResult } from "./types.js";
export interface VerificationSandboxResult extends ProcessResult {
    sandbox: {
        bubblewrapSha256: string;
        networkNamespace: "private_no_interfaces";
        worktreeMount: "writable";
        gitCommonMount: "read_only";
        hostHomeMounted: false;
        tmp: "tmpfs";
        resourceProfileId: string;
        resourceProfileHash: string;
        cgroupEnforced: boolean;
        rlimitsEnforced: true;
        aggregateWorktreeBytes: number;
    };
}
export declare function runVerificationSandboxCommand(config: BridgeConfig, worktreeInput: string, shellCommand: string, timeoutSeconds: number, profile: FrozenHostResourceProfile): Promise<VerificationSandboxResult>;
