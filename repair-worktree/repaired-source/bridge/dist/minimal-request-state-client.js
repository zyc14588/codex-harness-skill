function settings() {
    const baseUrl = process.env.CODEX_HARNESS_INTERNAL_BASE_URL?.replace(/\/+$/, "");
    const token = process.env.CODEX_HARNESS_INTERNAL_TOKEN;
    if (!baseUrl || !token)
        throw new Error("MINIMAL_TOOL_PLANE_COMPOSITION: isolated Bridge state relay is unavailable");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error("MINIMAL_TOOL_PLANE_COMPOSITION: state relay must use isolated IPv4 loopback HTTP");
    }
    return { baseUrl, token };
}
async function call(operation, input) {
    const { baseUrl, token } = settings();
    const response = await fetch(`${baseUrl}/internal/request-state/${operation}`, {
        method: "POST",
        headers: {
            "authorization": `Bearer ${token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error(`MINIMAL_TOOL_PLANE_COMPOSITION: state relay returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok) {
        const record = value && typeof value === "object" ? value : {};
        throw new Error(`MINIMAL_TOOL_PLANE_COMPOSITION: ${String(record.error ?? `state relay HTTP ${response.status}`)}`);
    }
    return value;
}
export async function publishMinimalRunnerSnapshot(input) {
    await call("publish-runner-snapshot", input);
}
export async function armMinimalPrimaryMutation(input) {
    await call("arm-primary-mutation", input);
}
export async function recordMinimalAdapterRequest(input) {
    return await call("record-adapter-request", input);
}
//# sourceMappingURL=minimal-request-state-client.js.map