import type { ProcessIdentity, ProcessResult } from "./types.js";
export declare function nowIso(): string;
export declare function expandHome(input: string): string;
export declare function pathExists(target: string): Promise<boolean>;
export declare function ensureDir(target: string): Promise<void>;
export declare function readJson<T>(target: string): Promise<T>;
export declare function atomicWriteJson(target: string, value: unknown): Promise<void>;
export declare function safeTaskId(input?: string): string;
export declare function normalizeRepoRelative(input: string): string;
export declare function validateLeasePattern(input: string): string;
export declare function leaseMatches(lease: string, filePath: string): boolean;
export declare function leasesOverlap(a: string, b: string): boolean;
export declare function assertDisjointLeases(harness: string[], codex: string[]): void;
export declare function isWithin(candidate: string, root: string): boolean;
export declare function processAlive(pid?: number): boolean;
export declare function tailText(target: string, maxChars: number): Promise<string>;
export declare function boundedText(value: string, field: string, maxChars: number): string;
export declare function boundedStringList(values: string[], field: string, maxItems: number, maxCharsPerItem: number): string[];
export declare function sha256PathTree(target: string): Promise<string>;
export declare function sleep(ms: number): Promise<void>;
export declare function runProcess(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
    maxCaptureChars?: number;
    killProcessGroup?: boolean;
    signal?: AbortSignal;
    abortGraceMs?: number;
    onProcessIdentity?: (identity: ProcessIdentity) => void | Promise<void>;
}): Promise<ProcessResult>;
export declare function jsonToolResult(value: unknown, isError?: boolean): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
};
