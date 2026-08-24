import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { loadConfig, defaultConfigPath } from "./config.js";
import { loadTask, listTasks, updateTask, withNamedLock } from "./store.js";
import {
  appendUsageEvent,
  budgetExceededReason,
  calculateCostCny,
  calculateCostUsd,
  clearBudgetMarker,
  markBudgetExceeded,
  parseProviderUsage,
  pricingForModel,
  projectedBudgetExceededReason,
  usageEventId,
  usageForBudgetGroup,
  writeUsageSnapshot,
} from "./telemetry.js";
import { buildMonitorSnapshot, monitorBaseUrl, persistMonitorSnapshot, type LiveUsageEstimate } from "./monitor.js";
import {
  listCostAdjustments,
  readFxRateState,
  setCorrectedBudgetGroupCostCny,
  setFxRateState,
} from "./adjustments.js";
import {
  clearBudgetOverride,
  effectiveBudget,
  listBudgetControlEvents,
  listBudgetOverrides,
  readOperatorControls,
  setBudgetOverride,
  setBudgetPolicy,
  setLlamaRuntimeConfig,
} from "./controls.js";
import {
  managedLlamaServerStatus,
  probeLlamaCpp,
  startManagedLlamaServer,
  stopManagedLlamaServer,
} from "./llama.js";
import {
  type BridgeConfig,
  type PricingEntry,
  type TaskBudget,
  type TaskRecord,
  type UsageTotals,
} from "./types.js";
import { nowIso } from "./util.js";
import {
  ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS,
  attemptInfrastructureAbortReason,
  normalizeProviderHttpFailure,
} from "./infrastructure-failure.js";
import {
  applyProviderOutputLimit,
  conservativeTokenUpperBound,
  estimateProviderInputTokens,
  providerModelLimits,
  requestedProviderOutputTokens,
} from "./provider-policy.js";
import {
  authorizeBearer,
  ensureOperatorToken,
  monitorSocketDirectory,
  monitorSocketPath,
  OperatorAuthGuard,
  readProviderApiKey,
  replaceOperatorToken,
} from "./security.js";
import { transformProviderToolCalls } from "./tool-call-recovery.js";
import { changedPaths } from "./git.js";
import { applyMinimalMutationPolicy, MINIMAL_MUTATION_POLICY_VERSION } from "./minimal-mutation-policy.js";
import {
  buildRedactedRequestEnvelope,
  armMinimalPrimaryMutation,
  claimMinimalWireRequest,
  isAuxiliaryPurpose,
  recordMinimalDiffObserved,
  recordMinimalAdapterRequest,
  recordMinimalMutationPolicyApplication,
  publishMinimalRunnerSnapshot,
} from "./minimal-request-state.js";
import {
  appendThinkingEvidence,
  captureReasoningRequirement,
  ensureAttemptThinkingPolicy,
  preflightThinkingRequest,
  type ThinkingRequestPreflight,
} from "./thinking-policy.js";
import { executeBrokeredTool } from "./brokered-tool-host.js";
import { brokeredToolProcessRegistry } from "./brokered-tool-registry.js";

const VERSION = "0.6.6";
const MAX_REQUEST_BYTES = 16_000_000;
const MAX_CONTROL_BYTES = 128_000;
const MAX_PROVIDER_RESPONSE_BYTES = 32_000_000;
const LIVE_BROADCAST_INTERVAL_MS = 400;
const sseClients = new Set<ServerResponse>();
const liveRequests = new Map<string, LiveUsageEstimate>();
const csrfToken = randomBytes(32).toString("hex");
let broadcastRunning = false;
let broadcastRequested = false;
let lastLiveBroadcastAt = 0;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > maxBytes) throw new HttpRequestError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class HttpRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

function parseBody(body: Buffer): Record<string, unknown> {
  if (!body.length) return {};
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpRequestError(400, "request body must be a JSON object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "request body must be valid JSON");
  }
}

async function readControlBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, MAX_CONTROL_BYTES);
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { throw new HttpRequestError(400, "request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpRequestError(400, "request body must be a JSON object");
  return value as Record<string, unknown>;
}

function upstreamChatUrl(base: string): URL {
  const root = base.replace(/\/+$/, "");
  return new URL(`${root}/chat/completions`);
}

function isJsonRequest(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  if (Array.isArray(raw) || typeof raw !== "string") return false;
  return raw.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

function activeAttempt(task: TaskRecord, attemptId: string): boolean {
  const attempt = task.executionAttempts?.at(-1);
  return attempt?.id === attemptId && attempt.completedAt === undefined && attempt.executor === "harness";
}

const PROVIDER_CHAT_KEYS = new Set([
  "frequency_penalty", "logprobs", "max_completion_tokens", "max_tokens", "messages", "model",
  "presence_penalty", "reasoning_effort", "response_format", "seed", "stop", "stream", "stream_options", "temperature",
  "thinking", "tool_choice", "tools", "top_logprobs", "top_p", "user",
]);

function assertProviderChatSchema(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !PROVIDER_CHAT_KEYS.has(key));
  if (unknown.length > 0) throw new HttpRequestError(400, `Provider request contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 160) {
    throw new HttpRequestError(400, "Provider request model must be a bounded non-empty string");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 512) {
    throw new HttpRequestError(400, "Provider request messages must contain 1-512 entries");
  }
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new HttpRequestError(400, "Provider request messages must be objects");
    }
    const role = (message as Record<string, unknown>).role;
    if (typeof role !== "string" || !["assistant", "developer", "system", "tool", "user"].includes(role)) {
      throw new HttpRequestError(400, "Provider request message role is invalid");
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new HttpRequestError(400, "Provider request stream must be boolean");
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 256)) {
    throw new HttpRequestError(400, "Provider request tools must be a bounded array");
  }
}

function safeRequestHeaders(request: IncomingMessage, providerApiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if ([
      "host", "content-length", "connection", "transfer-encoding", "authorization",
      "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key",
      "x-auth-token", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    ].includes(lower)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${providerApiKey}`);
  return headers;
}

function remainingOutput(totals: UsageTotals, budget: TaskBudget): number {
  return Math.max(0, budget.maxOutputTokens - totals.outputTokens - totals.estimatedOutputTokens);
}

function costOutputLimit(pricing: PricingEntry | undefined, budget: TaskBudget, totals: UsageTotals, inputEstimate: number): number | undefined {
  void pricing;
  void budget;
  void totals;
  void inputEstimate;
  return undefined;
}

function clampRequestBody(
  config: BridgeConfig,
  body: Record<string, unknown>,
  totals: UsageTotals,
  budget: TaskBudget,
  model: string,
  inputEstimate: number,
): { body: Buffer; projectedOutputTokens: number } {
  const modelLimits = providerModelLimits(model);
  if (inputEstimate >= modelLimits.contextWindowTokens) {
    throw new HttpRequestError(413, `canonical Provider input estimate ${inputEstimate} reaches the ${modelLimits.contextWindowTokens}-token context window`);
  }
  const requested = requestedProviderOutputTokens(body, budget.maxOutputTokens);
  const allowedByTokens = remainingOutput(totals, budget);
  const allowedByCost = costOutputLimit(pricingForModel(config, model), budget, totals, inputEstimate);
  const allowed = Math.max(0, Math.min(
    requested,
    allowedByTokens,
    modelLimits.maxOutputTokens,
    modelLimits.contextWindowTokens - inputEstimate,
    allowedByCost ?? Number.MAX_SAFE_INTEGER,
  ));
  if (allowed <= 0) throw new HttpRequestError(429, "Provider request has no remaining output-token capacity");
  applyProviderOutputLimit(body, allowed);
  return { body: Buffer.from(JSON.stringify(body)), projectedOutputTokens: allowed };
}

function usageFromCaptured(contentType: string, capture: Buffer): unknown {
  const text = capture.toString("utf8");
  if (contentType.includes("text/event-stream") || text.startsWith("data:")) {
    let usage: unknown;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const value = JSON.parse(data) as Record<string, unknown>;
        if (value.usage) usage = value.usage;
      } catch { /* ignore a partial event */ }
    }
    return usage;
  }
  try { return (JSON.parse(text) as Record<string, unknown>).usage; }
  catch { return undefined; }
}

function textualContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textualContent).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const reasoning = typeof record.reasoning_content === "string" ? record.reasoning_content : "";
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
      const fn = (tool as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) return "";
      const selected = fn as Record<string, unknown>;
      return `${typeof selected.name === "string" ? selected.name : ""}${typeof selected.arguments === "string" ? selected.arguments : ""}`;
    }).join("")
    : "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return `${reasoning}${toolCalls}${record.content}`;
  if (Array.isArray(record.content)) return `${reasoning}${toolCalls}${record.content.map(textualContent).join("")}`;
  return `${reasoning}${toolCalls}`;
}

function responseTextFromValue(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.delta === "string") return record.delta;
  if (Array.isArray(record.choices)) {
    return record.choices.map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const item = choice as Record<string, unknown>;
      return textualContent(item.delta) || textualContent(item.message) || textualContent(item.text);
    }).join("");
  }
  if (Array.isArray(record.output)) return record.output.map(textualContent).join("");
  return textualContent(record.content);
}

function responseTextFromCapture(contentType: string, capture: Buffer): string {
  const text = capture.toString("utf8");
  if (contentType.includes("text/event-stream") || text.startsWith("data:")) {
    let content = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { content += responseTextFromValue(JSON.parse(data)); } catch { /* partial event */ }
    }
    return content;
  }
  try { return responseTextFromValue(JSON.parse(text)); }
  catch { return text; }
}

function provisionalCost(pricing: PricingEntry | undefined, inputTokens: number, outputTokens: number): { cny: number; usd: number } {
  const usage = { inputTokens, outputTokens, cacheHitInputTokens: 0, cacheMissInputTokens: inputTokens };
  return { cny: calculateCostCny(pricing, usage) ?? 0, usd: calculateCostUsd(pricing, usage) ?? 0 };
}

function liveValues(): LiveUsageEstimate[] {
  return [...liveRequests.values()];
}

function reportBackgroundFailure(label: string, error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[${label}] ${message}\n`);
}

function scheduleBroadcast(config: BridgeConfig, label = "monitor background broadcast"): void {
  void broadcast(config).catch((error: unknown) => reportBackgroundFailure(label, error));
}

async function broadcast(config: BridgeConfig): Promise<void> {
  if (broadcastRunning) {
    broadcastRequested = true;
    return;
  }
  broadcastRunning = true;
  try {
    do {
      broadcastRequested = false;
      const snapshot = await persistMonitorSnapshot(config, liveValues());
      const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
      for (const client of [...sseClients]) {
        try { client.write(payload); } catch { sseClients.delete(client); }
      }
    } while (broadcastRequested);
  } finally { broadcastRunning = false; }
}

function requestLiveBroadcast(config: BridgeConfig, force = false): void {
  const now = Date.now();
  if (!force && now - lastLiveBroadcastAt < LIVE_BROADCAST_INTERVAL_MS) return;
  lastLiveBroadcastAt = now;
  scheduleBroadcast(config, "monitor live broadcast");
}

function updateLiveRequest(
  config: BridgeConfig,
  requestId: string,
  task: TaskRecord,
  inputTokens: number,
  outputTokens: number,
  pricing: PricingEntry | undefined,
): void {
  const cost = provisionalCost(pricing, inputTokens, outputTokens);
  liveRequests.set(requestId, {
    requestId,
    taskId: task.id,
    budgetGroupId: task.budgetGroupId,
    inputTokens,
    outputTokens,
    costCny: Number(cost.cny.toFixed(12)),
    costUsd: Number(cost.usd.toFixed(12)),
    updatedAt: nowIso(),
  });
  requestLiveBroadcast(config);
}

async function reconcileBudgetMarker(config: BridgeConfig, budgetGroupId: string): Promise<string | undefined> {
  const tasks = (await listTasks(config)).filter((task) => task.budgetGroupId === budgetGroupId);
  if (!tasks.length) throw new Error(`unknown budgetGroupId: ${budgetGroupId}`);
  const task = tasks[0]!;
  const totals = await usageForBudgetGroup(config, budgetGroupId);
  const budget = await effectiveBudget(config, task.budget, budgetGroupId);
  const reason = budgetExceededReason(totals, budget);
  if (reason) await markBudgetExceeded(config, task, reason, totals);
  else await clearBudgetMarker(config, budgetGroupId);
  return reason;
}

async function proxyRequest(config: BridgeConfig, request: IncomingMessage, response: ServerResponse, taskId: string, attemptId: string): Promise<void> {
  if (request.method !== "POST") return json(response, 405, { error: "Provider relay permits POST only" });
  if (!isJsonRequest(request)) return json(response, 415, { error: "Provider relay requires application/json" });
  let task: TaskRecord;
  try { task = await loadTask(config, taskId); }
  catch { return json(response, 403, { error: "invalid or inactive Provider capability" }); }
  if ((task.status !== "queued" && task.status !== "running") || !activeAttempt(task, attemptId)
    || !task.proxyToken || !authorizeBearer(request.headers.authorization, task.proxyToken)) {
    return json(response, 403, { error: "invalid or inactive Provider capability" });
  }
  if (!task.upstreamBaseUrl) return json(response, 500, { error: "task has no recorded upstream base URL" });

  await withNamedLock(config, `budget:${task.budgetGroupId}`, Math.max(30_000, task.runtimeSeconds * 1_000), async () => {
    let latest = await loadTask(config, task.id);
    if (latest.status !== "queued" && latest.status !== "running") return json(response, 409, { error: `task is ${latest.status}` });
    const existingAttemptAbort = attemptInfrastructureAbortReason(latest);
    if (existingAttemptAbort !== undefined) {
      request.resume();
      await broadcast(config);
      return json(response, ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS, {
        error: {
          message: existingAttemptAbort,
          type: latest.infrastructureFailureKind ?? "attempt_protocol_failure",
        },
      });
    }
    let rawBody: Buffer;
    try { rawBody = await readBody(request); }
    catch (error) { return json(response, 413, { error: error instanceof Error ? error.message : String(error) }); }

    let parsed: Record<string, unknown>;
    try { parsed = parseBody(rawBody); }
    catch (error) {
      const selected = error instanceof HttpRequestError ? error : new HttpRequestError(400, "invalid Provider request body");
      return json(response, selected.status, { error: { message: selected.message, type: "invalid_request" } });
    }
    try { assertProviderChatSchema(parsed); }
    catch (error) {
      const selected = error instanceof HttpRequestError ? error : new HttpRequestError(400, "invalid Provider request schema");
      return json(response, selected.status, { error: { message: selected.message, type: "invalid_request" } });
    }
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : (latest.fallbackModel ?? latest.model ?? "unknown-model");
    const upstreamBaseUrl = latest.upstreamBaseUrl;
    if (!upstreamBaseUrl) return json(response, 500, { error: "task has no recorded upstream base URL" });
    let providerRequestBody = parsed;
    let mutationPolicyApplied = false;
    let mutationPolicyTools: string[] = [];
    let thinkingPreflight: Extract<ThinkingRequestPreflight, { ok: true }> | undefined;
    let minimalRequestOrdinal: number | undefined;
    let minimalRequestPurpose: import("./types.js").MinimalRequestPurpose | undefined;
    if ((latest.effectiveExecutor ?? latest.executor) === "harness" && latest.harnessMode === "minimal") {
      const claim = await claimMinimalWireRequest(latest.id, buildRedactedRequestEnvelope("/chat/completions", parsed));
      if (!claim.ok) {
        await broadcast(config);
        return json(response, 502, { error: { message: claim.message, type: claim.kind } });
      }
      minimalRequestOrdinal = claim.evidence.requestOrdinal;
      minimalRequestPurpose = claim.evidence.purpose;
      latest = await loadTask(config, latest.id);
    }
    if (minimalRequestPurpose !== undefined && isAuxiliaryPurpose(minimalRequestPurpose)) {
      await updateTask(config, latest.id, (current) => {
        current.minimalMutationAuxiliaryBypassCount = (current.minimalMutationAuxiliaryBypassCount ?? 0) + 1;
        current.minimalMutationAuxiliaryBypassKinds = [...new Set([
          ...(current.minimalMutationAuxiliaryBypassKinds ?? []),
          minimalRequestPurpose!,
        ])];
        current.minimalMutationAuxiliaryLastAt = nowIso();
      });
    }
    if (minimalRequestPurpose === "primary_mutation" || minimalRequestPurpose === "mutation_followup") {
      let currentChangedPaths: string[];
      try {
        currentChangedPaths = await changedPaths(latest.worktreePath, latest.baseCommit);
      } catch (error) {
        const message = `minimal mutation preflight could not inspect the worktree: ${error instanceof Error ? error.message : String(error)}`;
        await updateTask(config, latest.id, (current) => {
          current.infrastructureFailureDetails = message;
        });
        await broadcast(config);
        return json(response, 502, { error: { message, type: "minimal_mutation_preflight" } });
      }
      if (currentChangedPaths.length > 0) await recordMinimalDiffObserved(latest.id);
      const mutationPolicy = applyMinimalMutationPolicy(latest, parsed, currentChangedPaths, model, minimalRequestPurpose);
      if (mutationPolicy.reason) {
        const policyFailure = mutationPolicy.reason;
        await updateTask(config, latest.id, (current) => {
          current.infrastructureFailureKind = "minimal_tool_serialization_mismatch";
          current.infrastructureFailureDetails = policyFailure;
          current.minimalRequestPhase = "terminal";
        });
        await broadcast(config);
        return json(response, 502, { error: { message: policyFailure, type: "minimal_tool_serialization_mismatch" } });
      }
      providerRequestBody = mutationPolicy.body;
      if (mutationPolicy.applied) {
        mutationPolicyApplied = true;
        mutationPolicyTools = mutationPolicy.toolNames;
      }
    }

    latest = await updateTask(config, latest.id, (current) => {
      const failure = ensureAttemptThinkingPolicy(current, model, nowIso());
      if (failure !== undefined) {
        current.infrastructureFailureKind = "thinking_policy_state";
        current.infrastructureFailureDetails = failure;
        current.thinkingPolicyFailureAt = nowIso();
        if (current.harnessMode === "minimal") current.minimalRequestPhase = "terminal";
      }
    });
    if (latest.infrastructureFailureKind === "thinking_policy_state") {
      await broadcast(config);
      return json(response, 502, { error: { message: latest.infrastructureFailureDetails, type: "thinking_policy_state" } });
    }
    const checked = preflightThinkingRequest(latest, providerRequestBody, model, nowIso());
    if (!checked.ok) {
      await updateTask(config, latest.id, (current) => {
        current.infrastructureFailureKind = checked.kind;
        current.infrastructureFailureDetails = checked.message;
        current.thinkingPolicyFailureAt = nowIso();
        if (current.harnessMode === "minimal") current.minimalRequestPhase = "terminal";
      });
      await broadcast(config);
      return json(response, 502, { error: { message: checked.message, type: checked.kind } });
    }
    thinkingPreflight = checked;

    const budget = await effectiveBudget(config, latest.budget, latest.budgetGroupId);
    let inputEstimate: number;
    try { inputEstimate = estimateProviderInputTokens(providerRequestBody, config.monitor.charsPerEstimatedToken); }
    catch (error) {
      return json(response, 400, { error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request" } });
    }
    const totals = await usageForBudgetGroup(config, latest.budgetGroupId);
    const existingReason = budgetExceededReason(totals, budget);
    if (!existingReason) await clearBudgetMarker(config, latest.budgetGroupId);
    let clamped: ReturnType<typeof clampRequestBody>;
    try { clamped = clampRequestBody(config, providerRequestBody, totals, budget, model, inputEstimate); }
    catch (error) {
      const selected = error instanceof HttpRequestError ? error : new HttpRequestError(400, error instanceof Error ? error.message : String(error));
      return json(response, selected.status, { error: { message: selected.message, type: selected.status === 429 ? "budget_exceeded" : "invalid_request" } });
    }
    const pricing = pricingForModel(config, model);
    const projectedUsage = {
      inputTokens: inputEstimate,
      outputTokens: clamped.projectedOutputTokens,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: inputEstimate,
    };
    const projectedCostCny = calculateCostCny(pricing, projectedUsage) ?? 0;
    const projectedCostUsd = calculateCostUsd(pricing, projectedUsage) ?? 0;
    const reason = existingReason ?? projectedBudgetExceededReason(
      totals,
      budget,
      inputEstimate,
      projectedCostUsd,
      clamped.projectedOutputTokens,
      projectedCostCny,
    );
    if (reason) {
      await appendUsageEvent(latest, { id: usageEventId(), kind: "budget_exceeded", model, usageSource: "estimated", error: reason });
      await markBudgetExceeded(config, latest, reason, totals);
      await broadcast(config);
      return json(response, 429, { error: { message: reason, type: "budget_exceeded" } });
    }

    if (mutationPolicyApplied) {
      if (minimalRequestOrdinal === undefined) throw new Error("forced minimal mutation request has no correlated ordinal");
      await recordMinimalMutationPolicyApplication({
        taskId: latest.id,
        requestOrdinal: minimalRequestOrdinal,
        toolNames: mutationPolicyTools,
        policyVersion: MINIMAL_MUTATION_POLICY_VERSION,
      });
    }

    latest = await updateTask(config, latest.id, (current) => {
      appendThinkingEvidence(current, thinkingPreflight!.evidence);
    });

    let providerApiKey: string;
    try { providerApiKey = await readProviderApiKey(config); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateTask(config, latest.id, (current) => {
        current.infrastructureFailureKind = "provider_credential";
        current.infrastructureFailureDetails = message;
      });
      await broadcast(config);
      return json(response, 503, { error: { message: "Provider credential is unavailable to the trusted proxy", type: "provider_credential" } });
    }

    const requestId = usageEventId();
    await appendUsageEvent(latest, {
      id: requestId,
      kind: "request_started",
      model,
      upstream: new URL(upstreamBaseUrl).origin,
      estimatedInputTokens: inputEstimate,
      estimatedOutputTokens: clamped.projectedOutputTokens,
      usageSource: "estimated",
    });
    updateLiveRequest(config, requestId, latest, inputEstimate, 0, pricing);
    requestLiveBroadcast(config, true);

    const started = Date.now();
    let upstream: Response;
    try {
      const upstreamHeaders = safeRequestHeaders(request, providerApiKey);
      // A cancelled or truncated provider stream can leave an undici pooled
      // socket stale. A later non-idempotent chat-completion POST must not be
      // retried blindly (that could double-charge the operator), so force a
      // fresh connection instead of relying on pool reuse.
      upstreamHeaders.set("connection", "close");
      const init: RequestInit = {
        method: "POST",
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(latest.runtimeSeconds * 1_000),
        body: clamped.body,
      };
      upstream = await fetch(upstreamChatUrl(upstreamBaseUrl), init);
    } catch (error) {
      liveRequests.delete(requestId);
      const cause = error instanceof Error && error.cause && typeof error.cause === "object"
        ? error.cause as { code?: unknown; message?: unknown }
        : undefined;
      const causeSuffix = cause
        ? ` (${typeof cause.code === "string" ? cause.code : "transport"}: ${typeof cause.message === "string" ? cause.message : "upstream connection failed"})`
        : "";
      const message = `${error instanceof Error ? error.message : String(error)}${causeSuffix}`;
      await updateTask(config, latest.id, (current) => {
        current.infrastructureFailureKind = "provider_transport";
        current.infrastructureFailureDetails = message;
      });
      const failedUsage = { inputTokens: inputEstimate, outputTokens: 0, cacheHitInputTokens: 0, cacheMissInputTokens: inputEstimate };
      const costCny = calculateCostCny(pricing, failedUsage);
      const costUsd = calculateCostUsd(pricing, failedUsage);
      await appendUsageEvent(latest, {
        id: usageEventId(), kind: "request_failed", model, latencyMs: Date.now() - started,
        estimatedInputTokens: inputEstimate, estimatedOutputTokens: 0,
        ...(costCny === undefined ? {} : { costCny }),
        ...(costUsd === undefined ? {} : { costUsd }),
        usageSource: "estimated", error: message,
      });
      await reconcileBudgetMarker(config, latest.budgetGroupId);
      await writeUsageSnapshot(config, latest);
      await broadcast(config);
      return json(response, 502, { error: { message, type: "upstream_error" } });
    }

    const chunks: Buffer[] = [];
    let captured = 0;
    let lastOutputEstimateAt = 0;
    const contentType = upstream.headers.get("content-type") ?? "";
    let streamError: string | undefined;
    let streamErrorType = "provider_transport";
    try {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          captured += chunk.length;
          if (captured > MAX_PROVIDER_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* response limit remains authoritative */ }
            throw new Error(`provider response exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`);
          }
          chunks.push(chunk);
          const now = Date.now();
          if (now - lastOutputEstimateAt >= LIVE_BROADCAST_INTERVAL_MS) {
            lastOutputEstimateAt = now;
            const currentCapture = Buffer.concat(chunks);
            const liveOutput = conservativeTokenUpperBound(responseTextFromCapture(contentType, currentCapture));
            updateLiveRequest(config, requestId, latest, inputEstimate, liveOutput, pricing);
            if (liveOutput > clamped.projectedOutputTokens) {
              try { await reader.cancel(); } catch { /* the local hard gate remains authoritative */ }
              streamError = `Provider output exceeded the frozen ${clamped.projectedOutputTokens}-token request gate`;
              streamErrorType = "provider_protocol_error";
              break;
            }
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
    }

    const capture = Buffer.concat(chunks);
    const provider = parseProviderUsage(usageFromCaptured(contentType, capture));
    const estimatedOutput = conservativeTokenUpperBound(responseTextFromCapture(contentType, capture));
    const usage = provider ?? {
      inputTokens: inputEstimate,
      outputTokens: estimatedOutput,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: inputEstimate,
    };
    const costCny = calculateCostCny(pricing, usage);
    const costUsd = calculateCostUsd(pricing, usage);

    let outgoingBody = capture;
    let outgoingContentType = contentType;
    let recoveryHeader: string | undefined;
    if (provider !== undefined && provider.outputTokens > clamped.projectedOutputTokens && streamError === undefined) {
      streamError = `Provider reported ${provider.outputTokens} output tokens beyond the frozen ${clamped.projectedOutputTokens}-token request gate`;
      streamErrorType = "provider_protocol_error";
    }
    if (streamError !== undefined) {
      const responseReadFailure = streamError;
      await updateTask(config, latest.id, (current) => {
        current.infrastructureFailureKind = streamErrorType === "provider_protocol_error" ? "provider_protocol" : "provider_transport";
        current.infrastructureFailureDetails = responseReadFailure;
      });
    }
    if (upstream.ok && !streamError) {
      if (latest.infrastructureFailureKind === "provider_transport") {
        await updateTask(config, latest.id, (current) => {
          if (current.infrastructureFailureKind === "provider_transport") {
            delete current.infrastructureFailureKind;
            delete current.infrastructureFailureDetails;
          }
        });
      }
      const transformed = transformProviderToolCalls(contentType, capture, providerRequestBody);
      const forcedToolCallMissing = mutationPolicyApplied
        && !transformed.failure
        && !transformed.changed
        && (transformed.nativeToolCallCount ?? 0) === 0;
      const transformFailure = transformed.failure
        ?? (forcedToolCallMissing
          ? `provider violated ${MINIMAL_MUTATION_POLICY_VERSION}: tool_choice=required returned no structured or safely recoverable tool call`
          : undefined);
      if (transformFailure) {
        const protocolFailure = transformFailure;
        streamError = `tool protocol recovery failed: ${protocolFailure}`;
        streamErrorType = "tool_protocol_error";
        await updateTask(config, latest.id, (current) => {
          current.infrastructureFailureKind = "tool_protocol";
          current.toolProtocolFailure = protocolFailure;
          current.toolProtocolFailureAt = nowIso();
        });
      } else {
        if (transformed.changed) {
          outgoingBody = transformed.body;
          outgoingContentType = transformed.contentType;
          recoveryHeader = transformed.recoveryKinds.join(",");
        }
        if (transformed.changed || (transformed.nativeToolCallCount ?? 0) > 0) {
          await updateTask(config, latest.id, (current) => {
            if (transformed.changed) {
              current.toolProtocolRecoveryCount = (current.toolProtocolRecoveryCount ?? 0) + 1;
              current.toolProtocolRecoveryKinds = [...new Set([...(current.toolProtocolRecoveryKinds ?? []), ...transformed.recoveryKinds])];
              current.toolProtocolRecoveredTools = [...new Set([...(current.toolProtocolRecoveredTools ?? []), ...transformed.recoveredToolNames])];
            }
            if ((transformed.nativeToolCallCount ?? 0) > 0) {
              current.toolProtocolNativeCallCount = (current.toolProtocolNativeCallCount ?? 0) + (transformed.nativeToolCallCount ?? 0);
              current.toolProtocolNativeTools = [...new Set([...(current.toolProtocolNativeTools ?? []), ...(transformed.nativeToolNames ?? [])])];
            }
            if (current.infrastructureFailureKind === "tool_protocol") delete current.infrastructureFailureKind;
            delete current.toolProtocolFailure;
            delete current.toolProtocolFailureAt;
          });
        }
      }
      if (streamError === undefined && thinkingPreflight.attempt.thinkingPolicy.thinkingType === "enabled") {
        const reasoning = captureReasoningRequirement(
          outgoingContentType,
          outgoingBody,
          thinkingPreflight.evidence.attemptId,
          thinkingPreflight.evidence.requestOrdinal,
          nowIso(),
        );
        if (!reasoning.ok) {
          streamError = `Provider protocol failed: ${reasoning.message}`;
          streamErrorType = "provider_protocol_error";
          await updateTask(config, latest.id, (current) => {
            current.infrastructureFailureKind = "provider_protocol";
            current.infrastructureFailureDetails = reasoning.message;
          });
        } else if (reasoning.requirement !== undefined) {
          await updateTask(config, latest.id, (current) => {
            const duplicate = (current.reasoningReplayRequirements ?? []).some((requirement) => (
              requirement.attemptId === reasoning.requirement!.attemptId
              && requirement.responseRequestOrdinal === reasoning.requirement!.responseRequestOrdinal
            ));
            if (!duplicate) {
              current.reasoningReplayRequirements = [
                ...(current.reasoningReplayRequirements ?? []),
                reasoning.requirement!,
              ];
            }
          });
        }
      }
    } else if (!upstream.ok) {
      const providerFailure = normalizeProviderHttpFailure(upstream.status, capture);
      await updateTask(config, latest.id, (current) => {
        current.infrastructureFailureKind = providerFailure.kind;
        current.infrastructureFailureDetails = providerFailure.details;
      });
    }

    liveRequests.delete(requestId);
    await appendUsageEvent(latest, {
      id: usageEventId(), kind: upstream.ok && !streamError ? "request_completed" : "request_failed", model,
      httpStatus: streamErrorType === "provider_protocol_error" || streamErrorType === "tool_protocol_error"
        ? ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS
        : streamError ? 502 : upstream.status,
      latencyMs: Date.now() - started,
      ...(provider ? {
        inputTokens: provider.inputTokens, outputTokens: provider.outputTokens,
        cacheHitInputTokens: provider.cacheHitInputTokens, cacheMissInputTokens: provider.cacheMissInputTokens,
        usageSource: "provider" as const,
      } : {
        estimatedInputTokens: inputEstimate, estimatedOutputTokens: estimatedOutput,
        usageSource: "estimated" as const,
      }),
      ...(costCny === undefined ? {} : { costCny }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(streamError ? { error: streamError } : upstream.ok ? {} : { error: `upstream HTTP ${upstream.status}` }),
    });
    await reconcileBudgetMarker(config, latest.budgetGroupId);
    await writeUsageSnapshot(config, latest);
    await broadcast(config);

    if (streamError) {
      const status = streamErrorType === "provider_protocol_error" || streamErrorType === "tool_protocol_error"
        ? ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS
        : 502;
      return json(response, status, { error: { message: streamError, type: streamErrorType } });
    }
    const outgoingHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!["content-length", "connection", "transfer-encoding", "content-encoding", "content-type"].includes(name.toLowerCase())) outgoingHeaders[name] = value;
    });
    if (outgoingContentType) outgoingHeaders["content-type"] = outgoingContentType;
    if (recoveryHeader) outgoingHeaders["x-codex-harness-tool-recovery"] = recoveryHeader;
    if (mutationPolicyApplied) {
      outgoingHeaders["x-codex-harness-minimal-mutation-policy"] = MINIMAL_MUTATION_POLICY_VERSION;
      outgoingHeaders["x-codex-harness-minimal-mutation-tools"] = mutationPolicyTools.join(",");
    }
    response.writeHead(upstream.status, outgoingHeaders);
    response.end(outgoingBody);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

function dashboardHtml(baseUrl: string, token: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Harness Control Center</title>
<style>
:root{color-scheme:light;--bg:#f2f6f3;--surface:#ffffff;--surface2:#f7faf8;--surface3:#edf4f0;--border:#d5e0da;--text:#26362f;--muted:#6d7f76;--accent:#6e9481;--accent-strong:#527563;--accent-soft:#e4eee8;--ok:#4f8567;--warn:#a7793e;--bad:#b35f63;--shadow:0 10px 30px rgba(55,78,66,.07);--radius:14px}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:linear-gradient(180deg,#eef4f0 0,#f6f8f6 420px,#f2f6f3 100%);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1480px;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:16px}.title{font-size:25px;font-weight:720;letter-spacing:-.025em;color:#304a3d}.subtitle{color:var(--muted);margin-top:5px}.status{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);text-align:right;background:rgba(255,255,255,.65);border:1px solid var(--border);border-radius:9px;padding:7px 10px;display:flex;align-items:center;gap:8px}.auth-button{width:auto;border:1px solid var(--border);border-radius:7px;background:#fff;color:var(--accent-strong);padding:4px 8px;cursor:pointer}.auth-panel{background:#fffdf7;border:1px solid #e7d6aa;border-left:4px solid var(--warn);border-radius:12px;padding:15px 17px;margin:0 0 18px;box-shadow:var(--shadow)}.auth-panel h2{font-size:16px;margin:0 0 5px;color:#6f542e}.auth-grid{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:9px;align-items:end;margin-top:10px}.auth-grid button{height:38px;width:auto;background:var(--accent-strong);color:#fff;border:1px solid var(--accent-strong);border-radius:9px;padding:0 16px;cursor:pointer}.tabs{display:flex;flex-wrap:wrap;gap:7px;border-bottom:1px solid var(--border);margin-bottom:20px}.tab{width:auto;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);padding:11px 18px;margin:0;border-radius:9px 9px 0 0;cursor:pointer;font-weight:650}.tab:hover{background:rgba(255,255,255,.56);color:var(--text)}.tab[aria-selected="true"]{color:var(--accent-strong);border-bottom-color:var(--accent);background:rgba(255,255,255,.78)}.view{display:none}.view.active{display:block}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-bottom:17px}.card,.panel{background:rgba(255,255,255,.9);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}.card{padding:16px}.label{color:var(--muted);font-size:12px}.value{font-size:24px;font-weight:700;margin-top:5px;color:#355244}.panel{padding:17px;margin-bottom:17px}.panel h2,.panel h3{margin:0 0 12px;font-size:16px;color:#365044}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.active-layout{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(0,2.1fr);gap:14px}.task-list{display:flex;flex-direction:column;gap:8px}.task-choice{width:100%;text-align:left;background:var(--surface2);border:1px solid var(--border);padding:11px;border-radius:10px;color:var(--text);cursor:pointer}.task-choice:hover{background:var(--accent-soft)}.task-choice.selected{border-color:var(--accent);background:#edf5f0;box-shadow:0 0 0 2px rgba(110,148,129,.12)}.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;background:#e7eef2;color:#526c7a;font-size:11px;margin-right:5px}.badge.ok{background:#e3f0e8;color:#3f7257}.badge.warn{background:#f6eddc;color:#8a6633}.badge.bad{background:#f7e5e6;color:#9b5055}.muted{color:var(--muted)}.small{font-size:12px}.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.detail{padding:11px;background:var(--surface2);border:1px solid #e5ece8;border-radius:10px;min-width:0}.detail .content{margin-top:4px;word-break:break-word}.wide{grid-column:1/-1}pre{white-space:pre-wrap;word-break:break-word;max-height:230px;overflow:auto;background:#f4f7f5;border:1px solid var(--border);border-radius:10px;padding:10px;color:#405c4e}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}table{width:100%;border-collapse:collapse;background:var(--surface);min-width:900px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e3ebe6;vertical-align:top;font-size:12px}th{color:var(--muted);font-weight:650;background:#f3f7f4;position:sticky;top:0}tbody tr:hover{background:#f8faf9}tr:last-child td{border-bottom:0}.ok-text{color:var(--ok)}.warn-text{color:var(--warn)}.bad-text{color:var(--bad)}label{display:block;color:var(--muted);font-size:12px;margin:8px 0 4px}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;background:#fbfdfc;color:var(--text);border:1px solid #cbd9d1;border-radius:9px;padding:8px 9px;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(110,148,129,.12)}input:disabled,select:disabled,button:disabled{cursor:not-allowed;opacity:.58}textarea{min-height:88px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions button{width:auto;margin:0;background:var(--accent-strong);color:#fff;border:1px solid var(--accent-strong);border-radius:9px;padding:8px 13px;cursor:pointer}.actions button:hover:not(:disabled){filter:brightness(.97)}.actions button.secondary{background:#f0f5f2;color:#4e685b;border-color:#cbd9d1}.actions button.danger{background:#b96a6e;border-color:#a75c60}.message{min-height:22px;margin-top:8px}.progress{height:5px;background:#e3ebe6;border-radius:99px;overflow:hidden;margin-top:5px}.progress span{display:block;height:100%;background:var(--accent)}.empty{padding:22px;text-align:center;color:var(--muted);background:var(--surface2);border:1px dashed #cbd9d1;border-radius:10px}.switch{display:flex;align-items:center;gap:8px}.switch input{width:auto;margin:0}.section-note{padding:11px 13px;background:#edf5f0;border-left:3px solid var(--accent);color:#4c6659;border-radius:8px;margin-bottom:12px}.advisory-box{background:#f8f3e8;border:1px solid #eadbbd;border-radius:10px;padding:12px}.advisory-box h3{color:#7d6138}.credential-note{max-width:820px}.credential-status{display:inline-flex;align-items:center;gap:6px;color:var(--ok);font-weight:650}.credential-status:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok)}@media(max-width:1000px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.active-layout,.grid2,.grid3{grid-template-columns:1fr}.top{flex-direction:column}.status{text-align:left}}@media(max-width:560px){.shell{padding:14px}.cards{grid-template-columns:1fr}.tab{padding:9px 12px}.details{grid-template-columns:1fr}.wide{grid-column:auto}.auth-grid{grid-template-columns:1fr}.auth-grid button{width:100%}}
</style></head><body data-theme="soft"><main class="shell">
<header class="top"><div><div class="title">Codex ↔ Harness 控制中心</div><div class="subtitle">任务执行、人民币费用治理与本地模型路由</div></div><div class="status"><span id="connection">正在连接…</span><button id="authenticate" class="auth-button" hidden>操作员登录</button></div></header>
<section id="authPanel" class="auth-panel" aria-labelledby="authTitle"><h2 id="authTitle">操作员认证</h2><div class="small">请输入操作员密码（Bearer 令牌）后加载任务与预算。首次登录使用安装器生成的 256-bit 随机令牌；认证失败会触发指数退避与审计。</div><div class="auth-grid"><div><label for="operatorCredential">操作员密码 / 令牌</label><input id="operatorCredential" type="password" autocomplete="current-password" spellcheck="false" placeholder="至少 12 个字符"></div><button id="loginOperator" type="button">登录并加载控制台</button></div><div id="authMessage" class="message small"></div></section>
<nav class="tabs" role="tablist"><button class="tab" data-tab="tasks" aria-selected="true">任务</button><button class="tab" data-tab="costs" aria-selected="false">费用</button><button class="tab" data-tab="llama" aria-selected="false">本地模型</button><button class="tab" data-tab="settings" aria-selected="false">设置</button></nav>
<section class="view active" id="view-tasks">
<div class="cards"><div class="card"><div class="label">正在执行</div><div class="value" id="activeCount">0</div></div><div class="card"><div class="label">排队任务</div><div class="value" id="queuedCount">0</div></div><div class="card"><div class="label">API 调用</div><div class="value" id="apiCalls">0</div></div><div class="card"><div class="label">实时累计费用</div><div class="value" id="taskCost">CN¥0.000000</div></div></div>
<div class="panel"><h2>当前执行任务</h2><div class="active-layout"><div id="activeTaskList" class="task-list"></div><div id="activeTaskDetail" class="empty">当前没有执行中的任务</div></div></div>
<div class="panel"><h2>自适应拆分记忆</h2><div class="section-note small">按仓库、任务族、执行器、模型和 Harness 模式保存历史判断。Token 超限、超时、回退、审查退回和验证失败会缩小后续叶子；稳定成功会谨慎放大。</div><div class="table-wrap"><table><thead><tr><th>任务族</th><th>样本</th><th>异常率</th><th>建议规模</th><th>建议复杂度</th><th>建议输入 / 输出门禁</th><th>更新时间</th></tr></thead><tbody id="memoryRows"></tbody></table></div></div>
<div class="panel"><h2>任务历史</h2><div class="table-wrap"><table><thead><tr><th>计划 / 叶子</th><th>目标</th><th>路由</th><th>状态</th><th>阶段</th><th>耗时</th><th>Token 门禁</th><th>费用</th></tr></thead><tbody id="taskRows"></tbody></table></div></div>
</section>
<section class="view" id="view-costs">
<div class="cards"><div class="card"><div class="label">最终原始估算</div><div class="value" id="rawCny">CN¥0.000000</div></div><div class="card"><div class="label">人工对账调整</div><div class="value" id="adjustmentCny">CN¥0.000000</div></div><div class="card"><div class="label">进行中估算</div><div class="value" id="liveCny">CN¥0.000000</div></div><div class="card"><div class="label">累计对账后费用</div><div class="value" id="totalCny">CN¥0.000000</div></div></div>
<div class="grid2"><div class="panel"><h2>全局预算策略</h2><div class="section-note small">输入 Token 与输出 Token 是唯一执行门禁。API 调用次数和人民币费用只用于参考、告警与人工治理，不会单独中止叶子任务。</div><div id="policyUnavailable" class="empty">请先完成操作员认证，认证后将显示全局预算调整框。</div><div id="policyControls" hidden><div class="grid2"><div><h3>普通叶子默认 Token 门禁</h3><div id="defaultBudgetFields"></div></div><div><h3>普通叶子运行时 Token 上限</h3><div id="maximumBudgetFields"></div></div><div class="wide advisory-box"><h3>Pro 复杂叶子默认高 Token 门禁</h3><div class="small muted">复杂叶子不受普通 operator ceiling 限制，但仍以自身冻结的输入/输出 Token 数量作为硬门禁；API 调用与费用字段仅供参考。</div><div id="proBudgetFields" class="grid3"></div></div></div><label>变更原因</label><input id="policyReason" maxlength="2000" placeholder="例如：调整复杂叶子的输入/输出 Token 门禁"><div class="actions"><button id="savePolicy">保存全局预算</button></div><div id="policyMessage" class="message small"></div></div></div>
<div class="panel"><h2>任务预算覆盖</h2><div id="overrideUnavailable" class="empty">请先完成操作员认证，认证后可选择 Budget group 调整任务预算。</div><div id="overrideControls" hidden><label>Budget group</label><select id="budgetGroup"></select><div id="overrideBudgetFields"></div><label>变更原因</label><input id="overrideReason" maxlength="2000" placeholder="例如：活动叶子补充预算"><div class="actions"><button id="saveOverride">应用/更新覆盖</button><button class="secondary" id="clearOverride">清除覆盖</button></div><div id="overrideMessage" class="message small"></div></div></div></div>
<div class="grid2"><div class="panel"><h2>人工费用对账</h2><div class="section-note small">仅允许终态 budget group。该操作追加对账记录，不改变 Token 账本，也不参与预算门禁。</div><label>Budget group</label><select id="costGroup"></select><label>修正后的人民币总额</label><input id="correctedCny" type="number" min="0" step="0.000000001" placeholder="0.015000000"><label>原因</label><input id="costReason" maxlength="1000" placeholder="例如：按供应商账单核对"><div class="actions"><button id="applyCorrection">追加对账记录</button></div><div id="costMessage" class="message small"></div></div>
<div class="panel"><h2>预算与费用说明</h2><div class="details"><div class="detail"><div class="label">主计价币种</div><div class="content">人民币（CN¥）</div></div><div class="detail"><div class="label">供应商账单权威性</div><div class="content">本地估算，不是最终账单</div></div><div class="detail wide"><div class="label">预算门禁</div><div class="content">所有叶子仅以输入 Token 和输出 Token 数量作为执行门禁。API 调用次数与人民币费用只生成参考告警；人工对账不参与执行门禁。</div></div><div class="detail wide"><div class="label">未定价调用</div><div class="content" id="unpricedCalls">0</div></div></div></div></div>
<div class="panel"><h2>费用明细</h2><div class="table-wrap"><table><thead><tr><th>Budget group</th><th>API（参考）</th><th>输入 Token 门禁</th><th>输出 Token 门禁</th><th>原始估算</th><th>人工调整</th><th>实时合计</th><th>费用参考值</th><th>Token 状态</th></tr></thead><tbody id="costRows"></tbody></table></div></div>
<div class="panel"><h2>最近人工对账</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>Budget group</th><th>修正前</th><th>修正后</th><th>差额</th><th>原因</th></tr></thead><tbody id="adjustmentRows"></tbody></table></div></div>
</section>
<section class="view" id="view-llama">
<div class="cards"><div class="card"><div class="label">启用状态</div><div class="value" id="llamaEnabled">—</div></div><div class="card"><div class="label">运行模式</div><div class="value" id="llamaMode">—</div></div><div class="card"><div class="label">托管服务</div><div class="value" id="llamaRunning">—</div></div><div class="card"><div class="label">自动回退</div><div class="value" id="llamaFallback">—</div></div></div>
<div class="panel"><h2>llama.cpp 运行配置</h2><div class="section-note small">支持外部 llama-server、自管 llama-server 和 llama-cli。命令以参数数组直接启动，不经过 shell。简单叶子仅在启用且符合精确文件租约时自动路由到本地模型；超时、不可用、进程或输出异常才会回退到固定的 deepseek-v4-flash。安全、范围、取消和预算错误不会自动回退。</div>
<div class="grid3"><div><label class="switch"><input id="llamaEnabledInput" type="checkbox">启用 llama.cpp</label></div><div><label class="switch"><input id="llamaAutoRoute" type="checkbox">自动路由简单叶子</label></div><div><label class="switch"><input id="llamaFallbackEnabled" type="checkbox">启用 Harness 回退</label></div></div>
<div class="grid2"><div><label>模式</label><select id="llamaModeInput"><option value="external_server">外部 llama-server</option><option value="managed_server">Bridge 托管 llama-server</option><option value="cli">llama-cli</option></select></div><div><label>模型标识</label><input id="llamaModel"></div><div><label>请求超时（秒）</label><input id="llamaTimeout" type="number" min="1"></div><div><label>OpenAI-compatible Base URL</label><input id="llamaBaseUrl"></div><div><label class="switch"><input id="llamaServerAutoStart" type="checkbox">任务需要时自动启动托管服务</label></div><div><label>启动健康检查超时（秒）</label><input id="llamaServerStartupTimeout" type="number" min="1"></div></div>
<div class="section-note small">可执行文件、SHA-256、工作目录、API 密钥来源和启动参数均由权限受限的安装配置固定，不能通过监控页面修改。</div>
<h3>叶子约束</h3><div class="grid3"><div><label>最大输出文件数</label><input id="llamaMaxFiles" type="number" min="1"></div><div><label>最大上下文文件数</label><input id="llamaMaxContextFiles" type="number" min="0"></div><div><label>最大输出 Token</label><input id="llamaMaxOutputTokens" type="number" min="1"></div><div><label>最大上下文字节</label><input id="llamaMaxContextBytes" type="number" min="1000"></div><div><label>单文件最大字节</label><input id="llamaMaxFileBytes" type="number" min="1000"></div><div><label>固定回退模型</label><input id="llamaFallbackModel" value="deepseek-v4-flash" disabled></div></div>
<div class="actions"><button id="saveLlama">保存本地模型配置</button><button class="secondary" id="probeLlama">探测</button><button class="secondary" id="startLlama">启动托管服务</button><button class="danger" id="stopLlama">停止托管服务</button></div><div id="llamaMessage" class="message small"></div><pre id="llamaProbe">尚未执行探测</pre></div>
</section>
<section class="view" id="view-settings">
<div class="panel"><h2>操作员认证</h2><div class="credential-note section-note small">监控 API 使用本机私密 Bearer 令牌，不在匿名 HTML、URL、日志或任务证据中暴露。新密码采用 NFC，至少 12 个字符，拒绝空白、控制、格式、双向控制及零宽字符；弱 6 字符兼容模式未启用。凭据原子写入 0600 operator.token，旧密码立即失效。</div><div id="credentialAuthenticated" hidden><div class="credential-status">当前浏览器会话已认证 · 强密码策略</div><div class="grid2"><div><label for="newOperatorCredential">新操作员密码</label><input id="newOperatorCredential" type="password" autocomplete="new-password" minlength="12" maxlength="16384" spellcheck="false" placeholder="至少 12 个字符且无控制/零宽字符"></div><div><label for="confirmOperatorCredential">确认新操作员密码</label><input id="confirmOperatorCredential" type="password" autocomplete="new-password" minlength="12" maxlength="16384" spellcheck="false" placeholder="再次输入新密码"></div></div><div class="actions"><button id="saveOperatorCredential">保存新操作员密码</button><button id="logoutOperator" class="secondary">退出当前浏览器认证</button></div><div id="credentialMessage" class="message small"></div></div><div id="credentialUnauthenticated" class="empty">请先在页面顶部完成操作员认证，随后即可在这里设置新密码。</div></div>
</section>
</main><script>
const BASE=${JSON.stringify(baseUrl)};const CSRF=${JSON.stringify(token)};let latest=null;let selectedActiveTask=null;
const q=s=>document.querySelector(s);const qa=s=>Array.from(document.querySelectorAll(s));
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c.charCodeAt(0)===34?"&quot;":"&#39;");
const cny=v=>"CN¥"+Number(v??0).toFixed(6);const num=v=>Number(v??0).toLocaleString("zh-CN");const dur=v=>v==null?"—":v<60?v+" 秒":v<3600?Math.floor(v/60)+" 分 "+v%60+" 秒":Math.floor(v/3600)+" 时 "+Math.floor(v%3600/60)+" 分";
function storedOperatorToken(){return sessionStorage.getItem("codexHarnessOperatorToken")||""}
function setMutationControlsDisabled(disabled){["savePolicy","saveOverride","clearOverride","applyCorrection","saveLlama","probeLlama","startLlama","stopLlama","saveOperatorCredential","logoutOperator"].forEach(id=>q("#"+id).disabled=disabled)}
function authenticationRequired(message="需要操作员认证"){q("#connection").textContent=message;q("#authenticate").hidden=true;q("#authPanel").hidden=false;q("#credentialAuthenticated").hidden=true;q("#credentialUnauthenticated").hidden=false;q("#policyControls").hidden=true;q("#policyUnavailable").hidden=false;q("#policyUnavailable").textContent="请先完成操作员认证，认证后将显示全局预算调整框。";q("#overrideControls").hidden=true;q("#overrideUnavailable").hidden=false;q("#overrideUnavailable").textContent="请先完成操作员认证，认证后可选择 Budget group 调整任务预算。";setMutationControlsDisabled(true)}
function authenticationSucceeded(){q("#authPanel").hidden=true;q("#authenticate").hidden=false;q("#authenticate").textContent="认证设置";q("#credentialAuthenticated").hidden=false;q("#credentialUnauthenticated").hidden=true;setMutationControlsDisabled(false)}
async function loginOperator(){const input=q("#operatorCredential"),token=input.value.trim();if(!token){setMessage("#authMessage","请输入操作员密码 / 令牌",false);input.focus();return}sessionStorage.setItem("codexHarnessOperatorToken",token);try{render(await api("/api/snapshot"));input.value="";setMessage("#authMessage","")}catch(e){setMessage("#authMessage",String(e.message||e),false)}}
function operatorToken(){const token=storedOperatorToken();if(!token)throw new Error("缺少操作员令牌");return token}
async function api(path,options={}){const headers=new Headers(options.headers||{});headers.set("authorization","Bearer "+operatorToken());const r=await fetch(BASE+path,{...options,headers});const text=await r.text();let v;try{v=JSON.parse(text)}catch{v={error:text||"invalid JSON"}}if(!r.ok){if(r.status===401){sessionStorage.removeItem("codexHarnessOperatorToken");authenticationRequired("认证失败，请重新输入令牌")}throw new Error(v.error?.message||v.error||("HTTP "+r.status))}return v}
function mutate(path,method,body){return api(path,{method,headers:{"content-type":"application/json","x-codex-harness-csrf":CSRF},body:JSON.stringify(body)})}
function setMessage(id,text,ok=true){const el=q(id);el.textContent=text;el.className="message small "+(ok?"ok-text":"bad-text")}
qa(".tab").forEach(button=>button.onclick=()=>{qa(".tab").forEach(x=>x.setAttribute("aria-selected",String(x===button)));qa(".view").forEach(x=>x.classList.toggle("active",x.id==="view-"+button.dataset.tab));localStorage.setItem("codexHarnessTab",button.dataset.tab)});const savedTab=localStorage.getItem("codexHarnessTab");if(savedTab){const b=q('.tab[data-tab="'+savedTab+'"]');if(b)b.click()}
function budgetFields(prefix,b){return '<label>API 调用参考阈值</label><input id="'+prefix+'Api" type="number" min="1" value="'+esc(b.maxApiCalls)+'"><label>输入 Token 硬门禁</label><input id="'+prefix+'Input" type="number" min="1" value="'+esc(b.maxInputTokens)+'"><label>输出 Token 硬门禁</label><input id="'+prefix+'Output" type="number" min="1" value="'+esc(b.maxOutputTokens)+'"><label>人民币费用参考阈值</label><input id="'+prefix+'Cost" type="number" min="0.000000001" step="0.000000001" value="'+esc(b.maxCostCny)+'">'}
function readBudget(prefix,base){return {gatePolicy:"input_output_tokens",ceilingPolicy:base.ceilingPolicy||"operator_bounded",enforcement:"hard",maxApiCalls:Number(q("#"+prefix+"Api").value),maxInputTokens:Number(q("#"+prefix+"Input").value),maxOutputTokens:Number(q("#"+prefix+"Output").value),maxCostCny:Number(q("#"+prefix+"Cost").value),maxCostUsd:base.maxCostUsd}}
function routeText(t){let value=(t.requestedExecutor||t.plannedExecutor)+" → "+(t.effectiveExecutor||t.plannedExecutor);if(t.fallbackUsed)value+="（回退）";return value}
function activeDetail(t){if(!t)return '<div class="empty">当前没有执行中的任务</div>';const attempts=(t.executionAttempts||[]).map(a=>'<span class="badge '+(a.outcome==="completed"?"ok":a.outcome?"bad":"warn")+'">'+esc(a.executor)+' · '+esc(a.model||"default")+' · '+esc(a.outcome||"running")+'</span>').join('');const d=t.splitDecision||{};return '<div class="details"><div class="detail"><div class="label">任务</div><div class="content mono">'+esc(t.taskId)+'</div></div><div class="detail"><div class="label">计划 / 叶子</div><div class="content mono">'+esc(t.planId)+' / '+esc(t.leafId)+'</div></div><div class="detail wide"><div class="label">目标</div><div class="content">'+esc(t.objective)+'</div></div><div class="detail"><div class="label">状态 / 阶段</div><div class="content">'+esc(t.status)+' / '+esc(t.phase||"—")+'</div></div><div class="detail"><div class="label">路由</div><div class="content">'+esc(routeText(t))+'</div></div><div class="detail"><div class="label">模型 / 复杂度</div><div class="content">'+esc(t.model||"default")+' / '+esc(t.complexity||"—")+'</div></div><div class="detail"><div class="label">Harness 模式 / 并行组</div><div class="content">'+esc(t.harnessMode||"—")+' / '+esc(t.parallelGroup||"—")+'</div></div><div class="detail"><div class="label">Token 门禁</div><div class="content">输入 '+num(t.budget.maxInputTokens)+' / 输出 '+num(t.budget.maxOutputTokens)+'</div></div><div class="detail"><div class="label">任务族</div><div class="content mono">'+esc(t.taskFamily||"—")+'</div></div><div class="detail"><div class="label">记忆建议 / 实际</div><div class="content">'+esc(d.recommendedComplexity||"—")+' → '+esc(d.chosenComplexity||t.complexity||"—")+'；规模 '+esc(d.recommendedLeafScale??"—")+'</div></div><div class="detail"><div class="label">已运行</div><div class="content">'+dur(t.elapsedSeconds)+'</div></div><div class="detail"><div class="label">费用（参考）</div><div class="content">'+cny(t.realtimeEstimatedCostCny)+' / '+cny(t.budget.maxCostCny)+'</div></div><div class="detail wide"><div class="label">参考告警</div><div class="content">'+esc((t.referenceAlerts||[]).join("\\n")||"无")+'</div></div><div class="detail wide"><div class="label">工具协议恢复</div><div class="content">'+(t.toolProtocolRecoveryCount?esc(String(t.toolProtocolRecoveryCount)+" 次；"+(t.toolProtocolRecoveryKinds||[]).join(", ")+"；工具="+(t.toolProtocolRecoveredTools||[]).join(", ")):"未触发")+'</div></div><div class="detail wide"><div class="label">Provider 原生工具调用</div><div class="content">'+(t.toolProtocolNativeCallCount?esc(String(t.toolProtocolNativeCallCount)+" 次；工具="+(t.toolProtocolNativeTools||[]).join(", ")):"未观察到")+'</div></div><div class="detail wide"><div class="label">Minimal 强制变更请求</div><div class="content">'+(t.minimalMutationForceCount?esc(String(t.minimalMutationForceCount)+" 次；策略="+(t.minimalMutationPolicyVersion||"—")+"；工具="+(t.minimalMutationForcedTools||[]).join(", ")+"；最近="+(t.minimalMutationLastAt||"—")):"未触发")+'</div></div><div class="detail wide"><div class="label">辅助模型请求隔离</div><div class="content">'+(t.minimalMutationAuxiliaryBypassCount?esc(String(t.minimalMutationAuxiliaryBypassCount)+" 次；类型="+(t.minimalMutationAuxiliaryBypassKinds||[]).join(", ")+"；最近="+(t.minimalMutationAuxiliaryLastAt||"—")):"未观察到")+'</div></div><div class="detail wide"><div class="label">基础设施异常</div><div class="content">'+esc(t.infrastructureFailureKind?String(t.infrastructureFailureKind)+"："+(t.infrastructureFailureDetails||t.toolProtocolFailure||""):"无")+'</div></div><div class="detail wide"><div class="label">执行尝试</div><div class="content">'+(attempts||"—")+'</div></div><div class="detail wide"><div class="label">写租约</div><div class="content mono">'+esc((t.harnessWritePaths||[]).join("\\n"))+'</div></div><div class="detail wide"><div class="label">验收标准</div><div class="content">'+esc((t.acceptanceCriteria||[]).join("\\n"))+'</div></div><div class="detail wide"><div class="label">stdout</div><pre>'+esc(t.stdoutTail||"（暂无输出）")+'</pre></div><div class="detail wide"><div class="label">stderr / 回退原因</div><pre>'+esc(t.stderrTail||t.fallbackReason||"（暂无错误）")+'</pre></div></div>'}
function renderTasks(s){q("#activeCount").textContent=s.activeTaskCount;q("#queuedCount").textContent=s.queuedTaskCount;q("#apiCalls").textContent=num(s.cumulativeUsage.apiCalls);q("#taskCost").textContent=cny(s.totalCostCny);const active=s.activeTasks||[];if(!selectedActiveTask||!active.some(t=>t.taskId===selectedActiveTask))selectedActiveTask=active[0]?.taskId||null;q("#activeTaskList").innerHTML=active.length?active.map(t=>'<button class="task-choice '+(t.taskId===selectedActiveTask?'selected':'')+'" data-task="'+esc(t.taskId)+'"><strong>'+esc(t.planId)+' / '+esc(t.leafId)+'</strong><div class="small muted">'+esc(t.phase||t.status)+' · '+esc(t.effectiveExecutor||t.plannedExecutor)+' · '+esc(t.harnessMode||"—")+' · '+dur(t.elapsedSeconds)+'</div></button>').join(''):'<div class="empty">无活动任务</div>';qa(".task-choice").forEach(b=>b.onclick=()=>{selectedActiveTask=b.dataset.task;renderTasks(latest)});q("#activeTaskDetail").className=active.length?"":"empty";q("#activeTaskDetail").innerHTML=activeDetail(active.find(t=>t.taskId===selectedActiveTask));q("#taskRows").innerHTML=(s.tasks||[]).map(t=>'<tr><td class="mono">'+esc(t.planId)+'<br>'+esc(t.leafId)+'</td><td>'+esc(t.objective)+'</td><td>'+esc(routeText(t))+'<br><span class="muted">'+esc(t.model||"default")+' · '+esc(t.complexity||"—")+' · '+esc(t.harnessMode||"—")+(t.toolProtocolRecoveryCount?' · 工具协议恢复 '+esc(t.toolProtocolRecoveryCount):'')+(t.minimalMutationForceCount?' · 强制变更请求 '+esc(t.minimalMutationForceCount):'')+'</span></td><td>'+esc(t.status)+'</td><td>'+esc(t.phase||"—")+'</td><td>'+dur(t.elapsedSeconds)+'</td><td class="'+(t.budgetState==="token_gate_exceeded"?"bad-text":"ok-text")+'">'+esc(t.budgetState)+'</td><td>'+cny(t.realtimeEstimatedCostCny)+'</td></tr>').join('');q("#memoryRows").innerHTML=((s.adaptiveSplitMemory&&s.adaptiveSplitMemory.profiles)||[]).map(m=>'<tr><td class="mono">'+esc(m.taskFamily)+'</td><td>'+num(m.sampleCount)+'</td><td>'+Number(m.anomalyCount/Math.max(1,m.sampleCount)*100).toFixed(1)+'%</td><td>'+esc(m.recommendedLeafScale)+'</td><td>'+esc(m.recommendedComplexity)+'</td><td>'+num(m.recommendedMaxInputTokens)+' / '+num(m.recommendedMaxOutputTokens)+'</td><td>'+esc(m.updatedAt)+'</td></tr>').join('')}
function uniqueGroups(tasks){return [...new Map(tasks.map(t=>[t.budgetGroupId,t])).values()]}
function renderCosts(s){q("#rawCny").textContent=cny(s.finalizedRawCostCny);q("#adjustmentCny").textContent=cny(s.manualAdjustmentCny);q("#liveCny").textContent=cny(s.liveEstimatedCostCny);q("#totalCny").textContent=cny(s.totalCostCny);q("#unpricedCalls").textContent=num(s.unpricedCalls);q("#policyUnavailable").hidden=true;q("#policyControls").hidden=false;const policy=s.budgetControls.policy;if(!q("#defaultApi")){q("#defaultBudgetFields").innerHTML=budgetFields("default",policy.defaultHarnessBudget);q("#maximumBudgetFields").innerHTML=budgetFields("maximum",policy.maximumHarnessBudget);q("#proBudgetFields").innerHTML=budgetFields("pro",policy.defaultProComplexBudget)}const groups=uniqueGroups(s.tasks||[]);const activeSel=q("#budgetGroup"),costSel=q("#costGroup");const oldActive=activeSel.value,oldCost=costSel.value;activeSel.innerHTML=groups.map(t=>'<option value="'+esc(t.budgetGroupId)+'">'+esc(t.planId)+' / '+esc(t.leafId)+' · '+esc(t.budgetGroupId)+'</option>').join('');const terminal=groups.filter(t=>!["queued","running"].includes(t.status));costSel.innerHTML=terminal.map(t=>'<option value="'+esc(t.budgetGroupId)+'">'+esc(t.planId)+' / '+esc(t.leafId)+' · '+esc(t.budgetGroupId)+'</option>').join('');if([...activeSel.options].some(o=>o.value===oldActive))activeSel.value=oldActive;if([...costSel.options].some(o=>o.value===oldCost))costSel.value=oldCost;const hasGroups=groups.length>0;q("#overrideUnavailable").hidden=hasGroups;q("#overrideUnavailable").textContent=hasGroups?"":"暂无可调整的任务预算；运行至少一个受治理任务后，这里会出现 Budget group。";q("#overrideControls").hidden=!hasGroups;activeSel.disabled=!hasGroups;q("#saveOverride").disabled=!hasGroups;q("#clearOverride").disabled=!hasGroups;renderOverrideFields();q("#costRows").innerHTML=groups.map(t=>'<tr><td class="mono">'+esc(t.budgetGroupId)+'</td><td>'+num(t.cumulativeUsage.apiCalls)+' / '+num(t.budget.maxApiCalls)+'</td><td>'+num(t.cumulativeUsage.inputTokens+t.cumulativeUsage.estimatedInputTokens+(t.liveUsage?.inputTokens||0))+' / '+num(t.budget.maxInputTokens)+'</td><td>'+num(t.cumulativeUsage.outputTokens+t.cumulativeUsage.estimatedOutputTokens+(t.liveUsage?.outputTokens||0))+' / '+num(t.budget.maxOutputTokens)+'</td><td>'+cny(t.rawEstimatedCostCny)+'</td><td>'+cny(t.manualAdjustmentCny)+'</td><td>'+cny(t.realtimeEstimatedCostCny)+'</td><td>'+cny(t.budget.maxCostCny)+'<br><span class="muted">参考阈值</span></td><td class="'+(t.budgetState==="token_gate_exceeded"?"bad-text":"ok-text")+'">'+esc(t.budgetState)+(t.referenceAlerts&&t.referenceAlerts.length?'<br><span class="warn-text">'+esc(t.referenceAlerts.join("；"))+'</span>':'')+'</td></tr>').join('');q("#adjustmentRows").innerHTML=(s.costAdjustments||[]).map(a=>'<tr><td>'+esc(a.at)+'</td><td class="mono">'+esc(a.budgetGroupId)+'</td><td>'+cny(a.beforeAdjustedCostCny)+'</td><td>'+cny(a.requestedCorrectedCostCny)+'</td><td>'+cny(a.deltaCny)+'</td><td>'+esc(a.reason)+'</td></tr>').join('')}
function renderOverrideFields(){if(!latest)return;const group=q("#budgetGroup").value;const row=(latest.tasks||[]).find(t=>t.budgetGroupId===group);const holder=q("#overrideBudgetFields");if(!row){holder.innerHTML="";return}const focus=holder.contains(document.activeElement);if(!focus)holder.innerHTML=budgetFields("override",row.budget)}
q("#budgetGroup").onchange=renderOverrideFields;
function fillLlama(l){const s=l.settings||{};q("#llamaEnabled").textContent=s.enabled?"已启用":"已禁用";q("#llamaMode").textContent=s.mode||"—";q("#llamaRunning").textContent=l.running?"运行中":"未运行";q("#llamaFallback").textContent=s.fallbackEnabled?"deepseek-v4-flash":"禁用";q("#llamaEnabledInput").checked=!!s.enabled;q("#llamaAutoRoute").checked=!!s.autoRouteSimpleLeaves;q("#llamaFallbackEnabled").checked=!!s.fallbackEnabled;q("#llamaModeInput").value=s.mode||"external_server";q("#llamaModel").value=s.model||"";q("#llamaTimeout").value=s.requestTimeoutSeconds||600;q("#llamaBaseUrl").value=s.baseUrl||"";q("#llamaServerAutoStart").checked=!!s.serverAutoStart;q("#llamaServerStartupTimeout").value=s.serverStartupTimeoutSeconds||90;q("#llamaMaxFiles").value=s.maxFilesPerTask||3;q("#llamaMaxContextFiles").value=s.maxContextFiles??8;q("#llamaMaxOutputTokens").value=s.maxOutputTokens||16384;q("#llamaMaxContextBytes").value=s.maxContextBytes||512000;q("#llamaMaxFileBytes").value=s.maxFileBytes||256000}
function render(s){latest=s;q("#connection").textContent="已连接 · v"+s.serviceVersion+" · "+new Date(s.generatedAt).toLocaleString("zh-CN");authenticationSucceeded();renderTasks(s);renderCosts(s);if(!q("#llamaModel").matches(":focus"))fillLlama(s.llamaCpp)}
q("#savePolicy").onclick=async()=>{try{const p=latest.budgetControls.policy;await mutate("/api/budget-policy","POST",{defaultHarnessBudget:readBudget("default",p.defaultHarnessBudget),maximumHarnessBudget:readBudget("maximum",p.maximumHarnessBudget),defaultProComplexBudget:readBudget("pro",p.defaultProComplexBudget),reason:q("#policyReason").value});setMessage("#policyMessage","全局预算已保存") }catch(e){setMessage("#policyMessage",String(e.message||e),false)}};
q("#saveOverride").onclick=async()=>{try{const group=q("#budgetGroup").value;const row=latest.tasks.find(t=>t.budgetGroupId===group);await mutate("/api/budget-overrides","POST",{budgetGroupId:group,budget:readBudget("override",row.budget),reason:q("#overrideReason").value});setMessage("#overrideMessage","预算覆盖已生效") }catch(e){setMessage("#overrideMessage",String(e.message||e),false)}};
q("#clearOverride").onclick=async()=>{try{await mutate("/api/budget-overrides","DELETE",{budgetGroupId:q("#budgetGroup").value,reason:q("#overrideReason").value||"dashboard clear"});setMessage("#overrideMessage","预算覆盖已清除") }catch(e){setMessage("#overrideMessage",String(e.message||e),false)}};
q("#applyCorrection").onclick=async()=>{try{await mutate("/api/cost-corrections","POST",{budgetGroupId:q("#costGroup").value,correctedCostCny:Number(q("#correctedCny").value),reason:q("#costReason").value});setMessage("#costMessage","已追加人工对账记录") }catch(e){setMessage("#costMessage",String(e.message||e),false)}};
function llamaForm(){return {enabled:q("#llamaEnabledInput").checked,autoRouteSimpleLeaves:q("#llamaAutoRoute").checked,mode:q("#llamaModeInput").value,baseUrl:q("#llamaBaseUrl").value,model:q("#llamaModel").value,serverAutoStart:q("#llamaServerAutoStart").checked,serverStartupTimeoutSeconds:Number(q("#llamaServerStartupTimeout").value),requestTimeoutSeconds:Number(q("#llamaTimeout").value),maxFilesPerTask:Number(q("#llamaMaxFiles").value),maxContextFiles:Number(q("#llamaMaxContextFiles").value),maxContextBytes:Number(q("#llamaMaxContextBytes").value),maxFileBytes:Number(q("#llamaMaxFileBytes").value),maxOutputTokens:Number(q("#llamaMaxOutputTokens").value),fallbackEnabled:q("#llamaFallbackEnabled").checked,fallbackModel:"deepseek-v4-flash"}}
q("#saveLlama").onclick=async()=>{try{await mutate("/api/llama/config","POST",{config:llamaForm()});setMessage("#llamaMessage","本地模型配置已保存") }catch(e){setMessage("#llamaMessage",String(e.message||e),false)}};
q("#probeLlama").onclick=async()=>{try{const r=await mutate("/api/llama/probe","POST",{});q("#llamaProbe").textContent=JSON.stringify(r,null,2);setMessage("#llamaMessage","探测完成",r.ok!==false)}catch(e){setMessage("#llamaMessage",String(e.message||e),false)}};
q("#startLlama").onclick=async()=>{try{const r=await mutate("/api/llama/server/start","POST",{});q("#llamaProbe").textContent=JSON.stringify(r,null,2);setMessage("#llamaMessage","托管服务启动完成") }catch(e){setMessage("#llamaMessage",String(e.message||e),false)}};
q("#stopLlama").onclick=async()=>{try{const r=await mutate("/api/llama/server/stop","POST",{});q("#llamaProbe").textContent=JSON.stringify(r,null,2);setMessage("#llamaMessage","托管服务已停止") }catch(e){setMessage("#llamaMessage",String(e.message||e),false)}};
q("#saveOperatorCredential").onclick=async()=>{const next=q("#newOperatorCredential").value.normalize("NFC"),confirmation=q("#confirmOperatorCredential").value.normalize("NFC"),characters=Array.from(next).length,bytes=new TextEncoder().encode(next).length;if(next!==confirmation){setMessage("#credentialMessage","两次输入的新密码不一致",false);return}if(characters<12||bytes>16384||/\\s/u.test(next)||/[\\p{Cc}\\p{Cf}]/u.test(next)){setMessage("#credentialMessage","新密码必须 NFC 规范化、至少 12 个字符且不含空白、控制、格式、双向控制或零宽字符",false);return}try{await mutate("/api/operator-credential","POST",{newToken:next});sessionStorage.setItem("codexHarnessOperatorToken",next);q("#newOperatorCredential").value="";q("#confirmOperatorCredential").value="";setMessage("#credentialMessage","新操作员密码已保存；旧密码已立即失效")}catch(e){setMessage("#credentialMessage",String(e.message||e),false)}};
q("#logoutOperator").onclick=()=>{sessionStorage.removeItem("codexHarnessOperatorToken");location.reload()};
async function refresh(){if(!storedOperatorToken()){authenticationRequired();return}try{render(await api("/api/snapshot"))}catch(e){q("#connection").textContent="连接失败："+e.message}}
q("#loginOperator").onclick=()=>void loginOperator();q("#operatorCredential").onkeydown=event=>{if(event.key==="Enter")void loginOperator()};q("#authenticate").onclick=()=>{const settings=q('.tab[data-tab="settings"]');if(storedOperatorToken()&&settings){settings.click();return}authenticationRequired();q("#operatorCredential").focus()};if(!storedOperatorToken())authenticationRequired();void refresh();setInterval(()=>void refresh(),2000);
</script></body></html>`;
}

function mutationAuthorized(request: IncomingMessage, baseUrl: string, operatorToken: string): string | undefined {
  if (!authorizeBearer(request.headers.authorization, operatorToken)) return "missing or invalid operator bearer";
  const origin = request.headers.origin;
  if (origin) {
    try { if (new URL(origin).origin !== new URL(baseUrl).origin) return "cross-origin mutation rejected"; }
    catch { return "invalid Origin header"; }
  }
  if (request.headers["x-codex-harness-csrf"] !== csrfToken) return "missing or invalid CSRF token";
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return "mutation requires application/json";
  return undefined;
}

function requiredString(value: unknown, field: string, fallback?: string): string {
  const selected = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!selected || selected.includes("\0")) throw new Error(`${field} must be a non-empty string`);
  return selected;
}

const config = await loadConfig();
const baseUrl = monitorBaseUrl(config);
let operatorToken = await ensureOperatorToken(config);
const operatorAuthGuard = new OperatorAuthGuard(config);

async function operatorAuthorized(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const decision = await operatorAuthGuard.authorize(
    request.headers.authorization,
    operatorToken,
    request.socket.remoteAddress ?? "unknown-local-client",
  );
  if (decision.ok) return true;
  response.setHeader("retry-after", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
  json(response, decision.status, {
    error: decision.status === 429 ? "operator authentication rate limited" : "missing or invalid operator bearer",
    retryAfterMs: decision.retryAfterMs,
  });
  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/health") {
      if (!await operatorAuthorized(request, response)) return;
      return json(response, 200, { ok: true, service: "codex-harness-monitor", pid: process.pid, version: VERSION });
    }
    if ((url.pathname.startsWith("/api/") || url.pathname === "/events")
      && !await operatorAuthorized(request, response)) return;
    if (url.pathname === "/api/snapshot") {
      const requested = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
      return json(response, 200, await buildMonitorSnapshot(config, limit, liveValues()));
    }
    if (url.pathname === "/api/adjustments" && request.method === "GET") return json(response, 200, { adjustments: await listCostAdjustments(config, 500) });
    if (url.pathname === "/api/budget-policy" && request.method === "GET") return json(response, 200, (await readOperatorControls(config)).budgetPolicy);
    if (url.pathname === "/api/budget-overrides" && request.method === "GET") return json(response, 200, { overrides: await listBudgetOverrides(config) });
    if (url.pathname === "/api/budget-audit" && request.method === "GET") return json(response, 200, { events: await listBudgetControlEvents(config, 500) });
    if (url.pathname === "/api/llama/config" && request.method === "GET") return json(response, 200, await managedLlamaServerStatus(config, false));
    if (url.pathname === "/api/fx" && request.method === "GET") return json(response, 200, await readFxRateState(config));

    if ((request.method === "POST" || request.method === "DELETE") && url.pathname.startsWith("/api/")) {
      const denied = mutationAuthorized(request, baseUrl, operatorToken);
      if (denied) return json(response, 403, { error: denied });
    }

    if (url.pathname === "/api/cost-corrections" && request.method === "POST") {
      const body = await readControlBody(request);
      if (typeof body.correctedCostCny !== "number" || !Number.isFinite(body.correctedCostCny) || body.correctedCostCny < 0) return json(response, 400, { error: "correctedCostCny must be a finite non-negative number" });
      const adjustment = await setCorrectedBudgetGroupCostCny(config, requiredString(body.budgetGroupId, "budgetGroupId"), body.correctedCostCny, requiredString(body.reason, "reason"), "dashboard");
      await broadcast(config);
      return json(response, 200, { ok: true, adjustment, snapshot: await buildMonitorSnapshot(config, 100, liveValues()) });
    }
    if (url.pathname === "/api/operator-credential" && request.method === "POST") {
      const body = await readControlBody(request);
      try {
        await withNamedLock(config, "operator-credential", 30_000, async () => {
          if (!authorizeBearer(request.headers.authorization, operatorToken)) {
            throw new HttpRequestError(401, "operator credential changed before this request completed");
          }
          operatorToken = await replaceOperatorToken(config, body.newToken);
        });
      }
      catch (error) {
        if (error instanceof HttpRequestError) throw error;
        throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
      }
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/api/budget-policy" && request.method === "POST") {
      const body = await readControlBody(request);
      const controls = await setBudgetPolicy(
        config, body.defaultHarnessBudget, body.maximumHarnessBudget, body.defaultProComplexBudget,
        requiredString(body.reason, "reason", "dashboard policy update"), "dashboard",
      );
      for (const task of await listTasks(config)) await reconcileBudgetMarker(config, task.budgetGroupId);
      await broadcast(config);
      return json(response, 200, { ok: true, policy: controls.budgetPolicy, snapshot: await buildMonitorSnapshot(config, 100, liveValues()) });
    }
    if (url.pathname === "/api/budget-overrides" && request.method === "POST") {
      const body = await readControlBody(request);
      const group = requiredString(body.budgetGroupId, "budgetGroupId");
      const record = await setBudgetOverride(config, group, body.budget, requiredString(body.reason, "reason", "dashboard override update"), "dashboard");
      await reconcileBudgetMarker(config, group);
      await broadcast(config);
      return json(response, 200, { ok: true, override: record, snapshot: await buildMonitorSnapshot(config, 100, liveValues()) });
    }
    if (url.pathname === "/api/budget-overrides" && request.method === "DELETE") {
      const body = await readControlBody(request);
      const group = requiredString(body.budgetGroupId, "budgetGroupId");
      await clearBudgetOverride(config, group, requiredString(body.reason, "reason", "dashboard override clear"), "dashboard");
      await reconcileBudgetMarker(config, group);
      await broadcast(config);
      return json(response, 200, { ok: true, snapshot: await buildMonitorSnapshot(config, 100, liveValues()) });
    }
    if (url.pathname === "/api/llama/config" && request.method === "POST") {
      const body = await readControlBody(request);
      let settings;
      try { settings = await setLlamaRuntimeConfig(config, body.config, "dashboard"); }
      catch (error) {
        throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
      }
      await broadcast(config);
      return json(response, 200, { ok: true, settings, snapshot: await buildMonitorSnapshot(config, 100, liveValues()) });
    }
    if (url.pathname === "/api/llama/probe" && request.method === "POST") return json(response, 200, await probeLlamaCpp(config));
    if (url.pathname === "/api/llama/server/start" && request.method === "POST") {
      const result = await startManagedLlamaServer(config);
      await broadcast(config);
      return json(response, 200, result);
    }
    if (url.pathname === "/api/llama/server/stop" && request.method === "POST") {
      const result = await stopManagedLlamaServer(config);
      await broadcast(config);
      return json(response, 200, result);
    }
    if (url.pathname === "/api/fx" && request.method === "POST") {
      const body = await readControlBody(request);
      const rate = body.usdToCnyRate;
      if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate))) return json(response, 400, { error: "usdToCnyRate must be a number or null" });
      const fx = await setFxRateState(config, rate as number | null, requiredString(body.asOf, "asOf"), requiredString(body.source, "source"), "dashboard");
      return json(response, 200, { ok: true, fx });
    }
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      response.write(`event: snapshot\ndata: ${JSON.stringify(await buildMonitorSnapshot(config, 100, liveValues()))}\n\n`);
      sseClients.add(response);
      request.once("close", () => sseClients.delete(response));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
      return response.end();
    }
    if (url.pathname === "/") {
      const body = Buffer.from(dashboardHtml(baseUrl, csrfToken));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      });
      return response.end(body);
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    const status = error instanceof HttpRequestError ? error.status : 500;
    if (!response.headersSent) json(response, status, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

function validStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256
    || !value.every((item) => typeof item === "string" && item.length <= 512 && !item.includes("\0"))) {
    throw new HttpRequestError(400, `${field} must be a bounded string array`);
  }
  return value as string[];
}

async function authorizedAdapterTask(request: IncomingMessage, taskId: string, attemptId: string): Promise<TaskRecord> {
  let task: TaskRecord;
  try { task = await loadTask(config, taskId); }
  catch { throw new HttpRequestError(403, "invalid or inactive Adapter capability"); }
  if ((task.status !== "queued" && task.status !== "running") || !activeAttempt(task, attemptId) || !task.adapterToken
    || !authorizeBearer(request.headers.authorization, task.adapterToken)) {
    throw new HttpRequestError(403, "invalid or inactive Adapter capability");
  }
  return task;
}

async function internalRequestState(
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  attemptId: string,
  operation: string,
): Promise<void> {
  if (request.method !== "POST") return json(response, 405, { error: "request-state operations require POST" });
  if (!isJsonRequest(request)) return json(response, 415, { error: "request-state operations require application/json" });
  const body = await readControlBody(request);
  const task = await authorizedAdapterTask(request, taskId, attemptId);
  if (body.taskId !== task.id) throw new HttpRequestError(400, "request-state body taskId does not match its route");
  if ((task.effectiveExecutor ?? task.executor) !== "harness" || task.harnessMode !== "minimal") {
    throw new HttpRequestError(403, "request-state operations require an active minimal Harness task");
  }
  if (operation === "publish-runner-snapshot") {
    if (typeof body.presetId !== "string" || !body.presetId || body.presetId.length > 512 || body.presetId.includes("\0")) {
      throw new HttpRequestError(400, "presetId must be a bounded string");
    }
    const requiredTools = body.requiredTools === undefined ? undefined : validStringArray(body.requiredTools, "requiredTools");
    await publishMinimalRunnerSnapshot({
      taskId: task.id,
      presetId: body.presetId,
      visibleTools: validStringArray(body.visibleTools, "visibleTools"),
      assembledTools: validStringArray(body.assembledTools, "assembledTools"),
      ...(requiredTools === undefined ? {} : { requiredTools }),
    });
    return json(response, 200, { ok: true });
  }
  if (operation === "arm-primary-mutation") {
    await armMinimalPrimaryMutation({ taskId: task.id });
    return json(response, 200, { ok: true });
  }
  if (operation === "record-adapter-request") {
    if (body.purpose !== undefined && (typeof body.purpose !== "string" || body.purpose.length > 160 || body.purpose.includes("\0"))) {
      throw new HttpRequestError(400, "purpose must be a bounded string");
    }
    if (body.reasoningEffort !== undefined && (typeof body.reasoningEffort !== "string" || body.reasoningEffort.length > 80 || body.reasoningEffort.includes("\0"))) {
      throw new HttpRequestError(400, "reasoningEffort must be a bounded string");
    }
    const result = await recordMinimalAdapterRequest({
      taskId: task.id,
      toolNames: validStringArray(body.toolNames, "toolNames"),
      ...(typeof body.purpose === "string" ? { purpose: body.purpose } : {}),
      ...(typeof body.reasoningEffort === "string" ? { reasoningEffort: body.reasoningEffort } : {}),
    });
    return json(response, 200, result);
  }
  return json(response, 404, { error: "unknown request-state operation" });
}

async function brokeredToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  attemptId: string,
): Promise<void> {
  const controller = new AbortController();
  const abort = (reason: string): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAborted = (): void => abort("brokered tool HTTP request aborted");
  const onRequestClose = (): void => {
    if (request.aborted || !request.complete) abort("brokered tool HTTP request closed before completion");
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) abort("brokered tool HTTP client connection closed");
  };
  request.once("aborted", onAborted);
  request.once("close", onRequestClose);
  response.once("close", onResponseClose);
  try {
  if (request.method !== "POST") return json(response, 405, { error: "brokered tools require POST" });
  if (!isJsonRequest(request)) return json(response, 415, { error: "brokered tools require application/json" });
  let task: TaskRecord;
  try { task = await loadTask(config, taskId); }
  catch { throw new HttpRequestError(403, "invalid or inactive tool capability"); }
  if ((task.status !== "queued" && task.status !== "running") || !activeAttempt(task, attemptId) || !task.toolToken
    || !authorizeBearer(request.headers.authorization, task.toolToken)) {
    throw new HttpRequestError(403, "invalid or inactive tool capability");
  }
  const body = parseBody(await readBody(request));
  if (controller.signal.aborted) return;
  if (body.taskId !== task.id) throw new HttpRequestError(400, "brokered tool body taskId does not match its route");
  if (typeof body.tool !== "string" || !/^[a-z_]{1,80}$/u.test(body.tool)) throw new HttpRequestError(400, "brokered tool name is invalid");
  const result = await executeBrokeredTool(config, task, body.tool, body.arguments ?? {}, {
    attemptId,
    signal: controller.signal,
  });
  if (controller.signal.aborted || response.destroyed) return;
  return json(response, 200, { result });
  } finally {
    request.off("aborted", onAborted);
    request.off("close", onRequestClose);
    response.off("close", onResponseClose);
  }
}

const internalServer = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://codex-harness-internal");
    if (url.search || url.hash) return json(response, 404, { error: "internal routes do not accept query or fragment components" });
    const provider = /^\/provider\/([A-Za-z0-9._-]{1,160})\/([A-Za-z0-9._-]{1,160})\/chat\/completions$/u.exec(url.pathname);
    if (provider?.[1] && provider[2]) return await proxyRequest(config, request, response, provider[1], provider[2]);
    const state = /^\/adapter-state\/([A-Za-z0-9._-]{1,160})\/([A-Za-z0-9._-]{1,160})\/(publish-runner-snapshot|arm-primary-mutation|record-adapter-request)$/u.exec(url.pathname);
    if (state?.[1] && state[2] && state[3]) return await internalRequestState(request, response, state[1], state[2], state[3]);
    const tool = /^\/tool-exec\/([A-Za-z0-9._-]{1,160})\/([A-Za-z0-9._-]{1,160})$/u.exec(url.pathname);
    if (tool?.[1] && tool[2]) return await brokeredToolRequest(request, response, tool[1], tool[2]);
    return json(response, 404, { error: "not found" });
  } catch (error) {
    const status = error instanceof HttpRequestError ? error.status : 500;
    if (!response.headersSent) json(response, status, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

const socketDirectory = monitorSocketDirectory(config);
const socketPath = monitorSocketPath(config);
await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
await chmod(socketDirectory, 0o700);
await rm(socketPath, { force: true });
await new Promise<void>((resolve, reject) => {
  internalServer.once("error", reject);
  internalServer.listen(socketPath, () => resolve());
});
await chmod(socketPath, 0o600);

server.listen(config.monitor.port, config.monitor.host, () => {
  void persistMonitorSnapshot(config, liveValues())
    .catch((error: unknown) => reportBackgroundFailure("monitor startup snapshot", error))
    .finally(() => {
      console.log(JSON.stringify({ service: "codex-harness-monitor", version: VERSION, pid: process.pid, baseUrl, configPath: defaultConfigPath() }));
    });
});

let brokeredReconcileRunning = false;
async function reconcileBrokeredToolProcesses(): Promise<void> {
  if (brokeredReconcileRunning) return;
  brokeredReconcileRunning = true;
  try {
    const taskIds = [...new Set(brokeredToolProcessRegistry.snapshot().map((entry) => entry.taskId))];
    for (const taskId of taskIds) {
      let task: TaskRecord;
      try { task = await loadTask(config, taskId); }
      catch {
        brokeredToolProcessRegistry.abortTask(taskId, "brokered tool task record disappeared");
        continue;
      }
      if ((task.status !== "queued" && task.status !== "running")
        || (task.effectiveExecutor ?? task.executor) !== "harness" || task.harnessMode !== "minimal") {
        brokeredToolProcessRegistry.abortTask(taskId, `brokered tool task became ${task.status}`);
        continue;
      }
      const attempt = task.executionAttempts?.at(-1);
      const activeAttemptId = attempt !== undefined && attempt.completedAt === undefined && attempt.executor === "harness" ? attempt.id : undefined;
      brokeredToolProcessRegistry.abortAttemptMismatch(taskId, activeAttemptId);
    }
  } finally {
    brokeredReconcileRunning = false;
  }
}

const snapshotTimer = setInterval(() => { scheduleBroadcast(config, "monitor periodic snapshot"); }, 2_000);
const brokeredToolTimer = setInterval(() => {
  void reconcileBrokeredToolProcesses().catch((error: unknown) => reportBackgroundFailure("brokered tool lifecycle reconciliation", error));
}, 100);
afterSignal("SIGTERM", 0);
afterSignal("SIGINT", 130);
let shuttingDown = false;
function afterSignal(signal: NodeJS.Signals, code: number): void {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(snapshotTimer);
    clearInterval(brokeredToolTimer);
    for (const client of sseClients) try { client.end(); } catch { /* ignore */ }
    brokeredToolProcessRegistry.abortAll(`Monitor ${signal}`);
    const hardStop = setTimeout(() => process.exit(code), 8_000);
    hardStop.unref();
    void (async () => {
      await brokeredToolProcessRegistry.waitForEmpty(6_000);
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => internalServer.close(() => resolve())),
      ]);
      await rm(socketPath, { force: true });
      clearTimeout(hardStop);
      process.exit(code);
    })();
  });
}
