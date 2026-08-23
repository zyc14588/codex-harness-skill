import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderOutputLimit, canonicalProviderRequest, conservativeTokenUpperBound, estimateProviderInputTokens, providerModelLimits, requestedProviderOutputTokens, } from "../provider-policy.js";
import { normalizeProviderHttpFailure } from "../infrastructure-failure.js";
test("canonical Provider gate includes tools, schemas, and every top-level field", () => {
    const messagesOnly = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "short" }] };
    const complete = {
        ...messagesOnly,
        thinking: { type: "disabled" },
        tools: [{
                type: "function",
                function: {
                    name: "write_fixture",
                    description: "x".repeat(800),
                    parameters: { type: "object", properties: { content: { type: "string", description: "y".repeat(800) } } },
                },
            }],
        response_format: { type: "json_object" },
    };
    assert.ok(estimateProviderInputTokens(complete, 4) > estimateProviderInputTokens(messagesOnly, 4) + 1_000);
    assert.equal(canonicalProviderRequest({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(estimateProviderInputTokens({ prompt: "abcd" }, 32), conservativeTokenUpperBound('{"prompt":"abcd"}'));
});
test("DeepSeek V4 per-request registry clamps output at 384K within a 1M context", () => {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
        assert.deepEqual(providerModelLimits(model), { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 });
    }
    assert.throws(() => providerModelLimits("unknown"), /unsupported Provider model/);
    assert.equal(requestedProviderOutputTokens({ max_tokens: 384_001 }, 1), 384_001);
    assert.throws(() => requestedProviderOutputTokens({ max_tokens: 1, max_completion_tokens: 1 }, 1), /must not specify both/);
    assert.throws(() => requestedProviderOutputTokens({ max_tokens: 0 }, 1), /positive integer/);
    const request = { max_completion_tokens: 400_000 };
    applyProviderOutputLimit(request, 384_000);
    assert.equal(request.max_completion_tokens, 384_000);
});
test("Provider HTTP errors become typed bounded categories without persisting response text", () => {
    const secret = "provider-body-secret-that-must-not-be-persisted";
    const replay = normalizeProviderHttpFailure(400, Buffer.from(`missing reasoning_content ${secret}`));
    assert.equal(replay.kind, "provider_protocol");
    assert.equal(replay.category, "reasoning_replay");
    assert.doesNotMatch(replay.details, new RegExp(secret));
    assert.equal(normalizeProviderHttpFailure(401, Buffer.from(secret)).kind, "provider_credential");
    assert.equal(normalizeProviderHttpFailure(429, Buffer.from(secret)).kind, "provider_transport");
    assert.equal(normalizeProviderHttpFailure(503, Buffer.from(secret)).category, "server");
});
//# sourceMappingURL=provider-policy.test.js.map