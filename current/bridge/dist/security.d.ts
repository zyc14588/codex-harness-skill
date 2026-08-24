import type { BridgeConfig, OperatorAuthAuditPolicy } from "./types.js";
export declare const OPERATOR_PASSWORD_MIN_CHARACTERS = 12;
export declare const DEFAULT_OPERATOR_AUTH_AUDIT_POLICY: OperatorAuthAuditPolicy;
export declare function bearerToken(requestAuthorization: string | string[] | undefined): string | undefined;
export declare function authorizeBearer(requestAuthorization: string | string[] | undefined, expected: string): boolean;
export declare function authorizeExactSecret(candidate: string | undefined, expected: string): boolean;
export interface OperatorAuthDecision {
    ok: boolean;
    status: 200 | 401 | 429;
    retryAfterMs: number;
}
/** Per-monitor backoff with credential-free, aggregated, bounded, rotated audit records. */
export declare class OperatorAuthGuard {
    #private;
    constructor(config: BridgeConfig);
    authorize(requestAuthorization: string | string[] | undefined, expected: string, source: string, nowMs?: number): Promise<OperatorAuthDecision>;
}
export declare function operatorTokenPath(config: BridgeConfig): string;
export declare function monitorSocketDirectory(config: BridgeConfig): string;
export declare function monitorSocketPath(config: BridgeConfig): string;
export declare function readPrivateSecret(target: string, label: string, minimumBytes?: number): Promise<string>;
export declare function ensureOperatorToken(config: BridgeConfig): Promise<string>;
export declare function validateOperatorToken(value: unknown, label?: string): string;
export declare function replaceOperatorToken(config: BridgeConfig, value: unknown): Promise<string>;
export declare function readProviderApiKey(config: BridgeConfig): Promise<string>;
