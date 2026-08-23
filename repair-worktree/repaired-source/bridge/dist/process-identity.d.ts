import type { ProcessIdentity } from "./types.js";
/** Capture an identity which remains safe across PID reuse. Linux is mandatory. */
export declare function captureProcessIdentity(pid: number): Promise<ProcessIdentity>;
/**
 * Capture a newly spawned process only after its interpreter/launcher exec
 * transition has settled. The identity must remain exact for the stability
 * window; any later exec still invalidates ordinary identity checks.
 */
export declare function captureSettledProcessIdentity(pid: number, timeoutMs?: number, stableMs?: number): Promise<ProcessIdentity>;
export declare function processIdentityMatches(identity: ProcessIdentity | undefined): Promise<boolean>;
export declare function assertProcessIdentity(identity: ProcessIdentity, label: string): Promise<void>;
/**
 * Signal only a verified process lifetime. The process group is accepted only
 * when it is led by the recorded PID, preventing a forged/stale PGID from
 * becoming signal authority.
 */
export declare function signalVerifiedProcessGroup(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<boolean>;
export declare function sha256Executable(target: string): Promise<{
    realpath: string;
    sha256: string;
}>;
