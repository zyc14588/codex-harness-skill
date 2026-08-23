import { estimateTokens } from "./telemetry.js";

export interface ProviderModelLimits {
  contextWindowTokens: 1_000_000;
  maxOutputTokens: 384_000;
}

export const PROVIDER_MODEL_LIMITS: Readonly<Record<string, ProviderModelLimits>> = Object.freeze({
  "deepseek-v4-flash": Object.freeze({ contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
  "deepseek-v4-pro": Object.freeze({ contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
});

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provider request contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Provider request contains a cycle");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const selected = record[key];
      if (selected !== undefined) result[key] = canonicalValue(selected, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error(`Provider request contains unsupported ${typeof value} data`);
}

/** Canonical full-envelope representation: messages, tools, schemas and all other fields count. */
export function canonicalProviderRequest(body: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(body, new Set()));
}

/**
 * Conservative tokenizer-independent ceiling. A byte-level tokenizer cannot
 * emit more model tokens than the number of UTF-8 bytes carrying the text.
 */
export function conservativeTokenUpperBound(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Buffer.byteLength(text, "utf8"));
}

export function estimateProviderInputTokens(body: Record<string, unknown>, charsPerToken: number): number {
  const canonical = canonicalProviderRequest(body);
  return Math.max(estimateTokens(canonical, charsPerToken), conservativeTokenUpperBound(canonical));
}

export function providerModelLimits(model: string): ProviderModelLimits {
  const limits = PROVIDER_MODEL_LIMITS[model];
  if (!limits) throw new Error(`unsupported Provider model: ${model}`);
  return limits;
}

export function requestedProviderOutputTokens(body: Record<string, unknown>, fallback: number): number {
  const hasCompletion = Object.hasOwn(body, "max_completion_tokens");
  const hasLegacy = Object.hasOwn(body, "max_tokens");
  if (hasCompletion && hasLegacy) throw new Error("Provider request must not specify both max_tokens and max_completion_tokens");
  const raw = hasCompletion ? body.max_completion_tokens : hasLegacy ? body.max_tokens : fallback;
  if (!Number.isInteger(raw) || Number(raw) <= 0) throw new Error("Provider output token limit must be a positive integer");
  return Number(raw);
}

export function applyProviderOutputLimit(body: Record<string, unknown>, allowed: number): void {
  if (!Number.isInteger(allowed) || allowed <= 0) throw new Error("Provider request has no output token capacity");
  if (Object.hasOwn(body, "max_completion_tokens")) body.max_completion_tokens = allowed;
  else body.max_tokens = allowed;
}
