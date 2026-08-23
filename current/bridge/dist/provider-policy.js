import { estimateTokens } from "./telemetry.js";
export const PROVIDER_MODEL_LIMITS = Object.freeze({
    "deepseek-v4-flash": Object.freeze({ contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
    "deepseek-v4-pro": Object.freeze({ contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
});
function canonicalValue(value, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Provider request contains a non-finite number");
        return value;
    }
    if (Array.isArray(value))
        return value.map((item) => canonicalValue(item, seen));
    if (typeof value === "object") {
        if (seen.has(value))
            throw new Error("Provider request contains a cycle");
        seen.add(value);
        const record = value;
        const result = {};
        for (const key of Object.keys(record).sort()) {
            const selected = record[key];
            if (selected !== undefined)
                result[key] = canonicalValue(selected, seen);
        }
        seen.delete(value);
        return result;
    }
    throw new Error(`Provider request contains unsupported ${typeof value} data`);
}
/** Canonical full-envelope representation: messages, tools, schemas and all other fields count. */
export function canonicalProviderRequest(body) {
    return JSON.stringify(canonicalValue(body, new Set()));
}
/**
 * Conservative tokenizer-independent ceiling. A byte-level tokenizer cannot
 * emit more model tokens than the number of UTF-8 bytes carrying the text.
 */
export function conservativeTokenUpperBound(text) {
    return text.length === 0 ? 0 : Math.max(1, Buffer.byteLength(text, "utf8"));
}
export function estimateProviderInputTokens(body, charsPerToken) {
    const canonical = canonicalProviderRequest(body);
    return Math.max(estimateTokens(canonical, charsPerToken), conservativeTokenUpperBound(canonical));
}
export function providerModelLimits(model) {
    const limits = PROVIDER_MODEL_LIMITS[model];
    if (!limits)
        throw new Error(`unsupported Provider model: ${model}`);
    return limits;
}
export function requestedProviderOutputTokens(body, fallback) {
    const hasCompletion = Object.hasOwn(body, "max_completion_tokens");
    const hasLegacy = Object.hasOwn(body, "max_tokens");
    if (hasCompletion && hasLegacy)
        throw new Error("Provider request must not specify both max_tokens and max_completion_tokens");
    const raw = hasCompletion ? body.max_completion_tokens : hasLegacy ? body.max_tokens : fallback;
    if (!Number.isInteger(raw) || Number(raw) <= 0)
        throw new Error("Provider output token limit must be a positive integer");
    return Number(raw);
}
export function applyProviderOutputLimit(body, allowed) {
    if (!Number.isInteger(allowed) || allowed <= 0)
        throw new Error("Provider request has no output token capacity");
    if (Object.hasOwn(body, "max_completion_tokens"))
        body.max_completion_tokens = allowed;
    else
        body.max_tokens = allowed;
}
//# sourceMappingURL=provider-policy.js.map