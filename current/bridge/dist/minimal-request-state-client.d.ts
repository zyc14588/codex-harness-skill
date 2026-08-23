import type { AdapterRequestInput, RunnerToolSnapshotInput } from "./minimal-request-state.js";
import type { MinimalRequestPurpose } from "./types.js";
export declare function publishMinimalRunnerSnapshot(input: RunnerToolSnapshotInput): Promise<void>;
export declare function armMinimalPrimaryMutation(input: {
    taskId: string;
}): Promise<void>;
export declare function recordMinimalAdapterRequest(input: AdapterRequestInput): Promise<{
    requestOrdinal: number;
    purpose: MinimalRequestPurpose;
}>;
