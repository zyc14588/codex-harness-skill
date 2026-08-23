import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTask, loadTask, taskDirectory } from "../store.js";
import { createExecutionAttempt } from "../thinking-policy.js";
import { usageForBudgetGroup } from "../telemetry.js";
import {
  ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS,
  attemptInfrastructureAbortReason,
} from "../infrastructure-failure.js";
import type { TaskRecord } from "../types.js";
import { sleep } from "../util.js";
import { ensureOperatorToken } from "../security.js";
import { testConfig } from "./test-config.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function unusedLoopbackPort(): Promise<number> {
  const probe = http.createServer((_request, response) => response.end());
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function waitForMonitor(port: number, child: ChildProcess, operatorToken: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`monitor exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      if (response.ok) return;
    } catch { /* monitor is still starting */ }
    await sleep(25);
  }
  throw new Error("monitor did not become ready");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([closed, sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function consume(_request: IncomingMessage): Promise<void> {
  for await (const _chunk of _request) { /* drain request */ }
}

async function socketJson(
  socketPath: string,
  requestPath: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: { error?: { type?: string; message?: string } } }> {
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { type?: string; message?: string } },
          });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.end(payload);
  });
}

function invalidThinkingToolCall(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({
    id: "provider-invalid-thinking-tool-call",
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-provider-omitted-reasoning",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "true" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 100,
    },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("provider protocol failure is a non-retryable attempt abort and blocks later Provider I/O", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-provider-protocol-fail-fast-"));
  const stateRoot = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const monitorPort = await unusedLoopbackPort();
  let providerCalls = 0;
  const provider = http.createServer(async (request, response) => {
    await consume(request);
    providerCalls += 1;
    invalidThinkingToolCall(response);
  });
  const providerPort = await listen(provider);
  const base = testConfig(stateRoot);
  const config = {
    ...base,
    harnessRoot: root,
    stateRoot,
    allowedRepoRoots: [root],
    monitor: {
      ...base.monitor,
      enabled: true,
      port: monitorPort,
      autoStart: false,
    },
  };
  await mkdir(stateRoot, { recursive: true });
  await mkdir(path.dirname(config.provider.apiKeyFile), { recursive: true, mode: 0o700 });
  await writeFile(config.provider.apiKeyFile, "provider-test-key-that-never-came-from-the-task\n", { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const operatorToken = await ensureOperatorToken(config);

  const taskId = "provider-protocol-fail-fast";
  const proxyToken = "a".repeat(48);
  const taskDir = taskDirectory(config, taskId);
  const now = new Date().toISOString();
  const attempt = createExecutionAttempt("harness", "deepseek-v4-pro", 1, now);
  assert.ok(attempt.id);
  const task: TaskRecord = {
    schemaVersion: 6,
    id: taskId,
    planId: "provider-protocol-fail-fast-plan",
    leafId: "provider-protocol-fail-fast-leaf",
    budgetGroupId: taskId,
    requestedExecutor: "harness",
    executor: "harness",
    effectiveExecutor: "harness",
    routingReason: "test",
    complexity: "small",
    harnessMode: "standard",
    dependsOn: [],
    toolCapabilities: [],
    taskFamily: "test/provider-protocol-fail-fast",
    splitDecision: {
      memorySchemaVersion: 4,
      memoryKey: "provider-protocol-fail-fast-memory",
      taskFamily: "test/provider-protocol-fail-fast",
      memoryRevision: 0,
      sampleCount: 0,
      ignoredLegacySampleCount: 0,
      confidence: 0,
      recommendedLeafScale: 1,
      recommendedComplexity: "small",
      recommendedMaxInputTokens: 100_000,
      recommendedMaxOutputTokens: 10_000,
      anomalyRate: 0,
      rationale: ["test"],
      chosenComplexity: "small",
      chosenMaxInputTokens: 100_000,
      chosenMaxOutputTokens: 10_000,
    },
    mode: "analysis",
    phase: "execution",
    objective: "exercise provider protocol fail-fast",
    repoRoot: root,
    baseRef: "test-base",
    baseCommit: "test-base",
    startingHeadCommit: "test-base",
    branchName: "test/provider-protocol-fail-fast",
    worktreePath: root,
    harnessWritePaths: [],
    codexWritePaths: [],
    acceptanceCriteria: [],
    contextFiles: [],
    verificationCommands: [],
    budget: {
      gatePolicy: "input_output_tokens",
      ceilingPolicy: "operator_bounded",
      enforcement: "hard",
      maxApiCalls: 4,
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostCny: 1,
      maxCostUsd: 1,
    },
    model: "deepseek-v4-pro",
    status: "running",
    createdAt: now,
    startedAt: now,
    runtimeSeconds: 30,
    promptPath: path.join(taskDir, "prompt.md"),
    stdoutPath: path.join(taskDir, "stdout.log"),
    stderrPath: path.join(taskDir, "stderr.log"),
    usagePath: path.join(taskDir, "usage.ndjson"),
    proxyToken,
    upstreamBaseUrl: `http://127.0.0.1:${providerPort}`,
    changedPaths: [],
    outOfScopePaths: [],
    executionAttempts: [attempt],
    providerRequestOrdinal: 0,
    thinkingRequestEvidence: [],
    reasoningReplayRequirements: [],
  };
  await createTask(config, task);

  const daemonPath = fileURLToPath(new URL("../monitor-daemon.js", import.meta.url));
  const monitor = spawn(process.execPath, [daemonPath], {
    env: { ...process.env, CODEX_HARNESS_CONFIG: configPath },
    stdio: "ignore",
  });
  const requestBody = {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "call the disclosed tool" }],
    tools: [{
      type: "function",
      function: {
        name: "bash",
        description: "run a bounded command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    }],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: true,
  };
  const proxyPath = `/proxy/${proxyToken}/v1/chat/completions`;
  const socketPath = path.join(stateRoot, "monitor-internal", "monitor.sock");

  try {
    await waitForMonitor(monitorPort, monitor, operatorToken);
    const publicAttempt = await fetch(`http://127.0.0.1:${monitorPort}${proxyPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(publicAttempt.status, 404, "Provider proxy was exposed on the public TCP listener");
    const first = await socketJson(socketPath, proxyPath, proxyToken, requestBody);
    assert.equal(first.status, ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS);
    assert.equal(first.body.error?.type, "provider_protocol_error");
    assert.match(first.body.error?.message ?? "", /omitted non-empty reasoning_content/u);
    assert.equal(providerCalls, 1);

    const second = await socketJson(socketPath, proxyPath, proxyToken, requestBody);
    assert.equal(second.status, ATTEMPT_PROTOCOL_FAILURE_HTTP_STATUS);
    assert.equal(second.body.error?.type, "provider_protocol");
    assert.match(second.body.error?.message ?? "", /omitted non-empty reasoning_content/u);
    assert.equal(providerCalls, 1, "a later same-attempt request reached the Provider");

    const stored = await loadTask(config, taskId);
    assert.equal(stored.infrastructureFailureKind, "provider_protocol");
    assert.equal(stored.providerRequestOrdinal, 1);
    assert.equal(stored.thinkingRequestEvidence?.length, 1);
    assert.match(attemptInfrastructureAbortReason(stored) ?? "", /omitted non-empty reasoning_content/u);
    const usage = await usageForBudgetGroup(config, taskId);
    assert.equal(usage.apiCalls, 1);
    assert.equal(usage.failedCalls, 1);
    assert.equal(usage.completedCalls, 0);
  } finally {
    await stopChild(monitor);
    await closeServer(provider);
    await rm(root, { recursive: true, force: true });
  }
});

test("transient transport and terminal no-effect states are not attempt abort signals", () => {
  assert.equal(attemptInfrastructureAbortReason({
    infrastructureFailureKind: "provider_transport",
    infrastructureFailureDetails: "temporary connection reset",
  }), undefined);
  assert.equal(attemptInfrastructureAbortReason({
    infrastructureFailureKind: "no_effect",
    infrastructureFailureDetails: "computed after worker exit",
  }), undefined);
});
