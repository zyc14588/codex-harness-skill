export interface ProviderModelLimits {
    contextWindowTokens: 1_000_000;
    maxOutputTokens: 384_000;
}
export declare const PROVIDER_MODEL_LIMITS: Readonly<Record<string, ProviderModelLimits>>;
/** Canonical full-envelope representation: messages, tools, schemas and all other fields count. */
export declare function canonicalProviderRequest(body: Record<string, unknown>): string;
/**
 * Conservative tokenizer-independent ceiling. A byte-level tokenizer cannot
 * emit more model tokens than the number of UTF-8 bytes carrying the text.
 */
export declare function conservativeTokenUpperBound(text: string): number;
export declare function estimateProviderInputTokens(body: Record<string, unknown>, charsPerToken: number): number;
export declare function providerModelLimits(model: string): ProviderModelLimits;
export declare function requestedProviderOutputTokens(body: Record<string, unknown>, fallback: number): number;
export declare function applyProviderOutputLimit(body: Record<string, unknown>, allowed: number): void;
