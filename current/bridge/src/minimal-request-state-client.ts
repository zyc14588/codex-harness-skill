import type { AdapterRequestInput, RunnerToolSnapshotInput } from "./minimal-request-state.js";
import type { MinimalRequestPurpose } from "./types.js";

function settings(): { baseUrl: string; token: string } {
  const baseUrl = process.env.CODEX_HARNESS_ADAPTER_STATE_URL?.replace(/\/+$/, "");
  const token = process.env.CODEX_HARNESS_ADAPTER_TOKEN;
  if (!baseUrl || !token) throw new Error("MINIMAL_TOOL_PLANE_COMPOSITION: isolated Bridge state relay is unavailable");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("MINIMAL_TOOL_PLANE_COMPOSITION: state relay must use isolated IPv4 loopback HTTP");
  }
  return { baseUrl, token };
}

async function call<T>(operation: string, input: unknown): Promise<T> {
  const { baseUrl, token } = settings();
  const response = await fetch(`${baseUrl}/${operation}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`MINIMAL_TOOL_PLANE_COMPOSITION: state relay returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    throw new Error(`MINIMAL_TOOL_PLANE_COMPOSITION: ${String(record.error ?? `state relay HTTP ${response.status}`)}`);
  }
  return value as T;
}

export async function publishMinimalRunnerSnapshot(input: RunnerToolSnapshotInput): Promise<void> {
  await call("publish-runner-snapshot", input);
}

export async function armMinimalPrimaryMutation(input: { taskId: string }): Promise<void> {
  await call("arm-primary-mutation", input);
}

export async function recordMinimalAdapterRequest(input: AdapterRequestInput): Promise<{ requestOrdinal: number; purpose: MinimalRequestPurpose }> {
  return await call("record-adapter-request", input);
}
