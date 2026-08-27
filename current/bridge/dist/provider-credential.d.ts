export declare const CREDENTIAL_POLICY = "DEDICATED_DISPOSABLE_MANUAL_REVOKE_VERIFIED";
export declare const OFFICIAL_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export declare const OFFICIAL_DEEPSEEK_MODELS_ENDPOINT = "https://api.deepseek.com/models";
export declare const REVOCATION_ACCEPTED_STATUSES: readonly [401, 403];
export declare const REVOCATION_MAX_WAIT_SECONDS = 900;
export declare const REVOCATION_POLL_INTERVAL_SECONDS = 15;
export interface ProtectedProviderCredential {
    value: string;
    fingerprintSha256: string;
}
export interface CredentialRevocationEvidence {
    schemaVersion: 1;
    result: "PASS";
    provider: "deepseek";
    credentialPolicy: typeof CREDENTIAL_POLICY;
    credentialFingerprintSha256: string;
    repository: string;
    headSha: string;
    headTree: string;
    runId: number;
    runAttempt: number;
    endpoint: typeof OFFICIAL_DEEPSEEK_MODELS_ENDPOINT;
    revocationObservedAt: string;
    revocationHttpStatus: 401 | 403;
    acceptedStatuses: readonly [401, 403];
    probeAttempts: number;
    maxWaitSeconds: number;
    pollIntervalSeconds: number;
    responseBodyCaptured: false;
}
export interface RevocationProbeRecord {
    httpStatus: number;
    attempt: number;
    timestamp: string;
}
export declare class CredentialRevocationNotObservedError extends Error {
    readonly code = "FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED";
    constructor();
}
export declare function credentialFingerprintSha256(rawBytes: Uint8Array): string;
export declare function readProtectedProviderCredential(source: string): Promise<ProtectedProviderCredential>;
export declare function isCredentialRevocationStatus(httpStatus: number): httpStatus is 401 | 403;
export declare function probeOfficialDeepSeekCredential(apiKey: string, timeoutMs: number): Promise<number>;
interface WaitForCredentialRevocationOptions {
    credentialFingerprintSha256: string;
    repository: string;
    headSha: string;
    headTree: string;
    runId: number;
    runAttempt: number;
    probe: (timeoutMs: number) => Promise<number>;
    onAttempt?: (record: RevocationProbeRecord) => void;
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
    maxWaitSeconds?: number;
    pollIntervalSeconds?: number;
}
export declare function waitForCredentialRevocation(options: WaitForCredentialRevocationOptions): Promise<CredentialRevocationEvidence>;
export {};
