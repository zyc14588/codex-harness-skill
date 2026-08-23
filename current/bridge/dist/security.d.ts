import type { BridgeConfig } from "./types.js";
export declare const OPERATOR_PASSWORD_MIN_CHARACTERS = 12;
export declare function bearerToken(requestAuthorization: string | string[] | undefined): string | undefined;
export declare function authorizeBearer(requestAuthorization: string | string[] | undefined, expected: string): boolean;
export declare function authorizeExactSecret(candidate: string | undefined, expected: string): boolean;
export interface OperatorAuthDecision {
    ok: boolean;
    status: 200 | 401 | 429;
    retryAfterMs: number;
}
/** Per-monitor in-memory exponential backoff with a credential-free append-only audit. */
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
