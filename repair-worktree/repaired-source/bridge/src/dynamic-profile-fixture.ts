import assert from "node:assert/strict";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupTask,
  createControllerPlan,
  inspectMinimalProfileComposition,
  monitorStop,
  startTask,
  taskStatus,
} from "./service.js";
import { loadConfig } from "./config.js";
import { adviseSplit, recordTaskSplitOutcome } from "./split-memory.js";
import { createTask, loadTask, taskDirectory, updateTask } from "./store.js";
import { usageForBudgetGroup } from "./telemetry.js";
import { captureReasoningRequirement, createExecutionAttempt } from "./thinking-policy.js";
import type { TaskRecord } from "./types.js";
import { runProcess, sha256PathTree, sleep } from "./util.js";
import { sha256Executable } from "./process-identity.js";
import { monitorSocketPath } from "./security.js";

const EXPECTED_HARNESS_COMMIT = process.env.CODEX_HARNESS_FIXTURE_EXPECTED_COMMIT
  ?? "141eb6fef83422698aef7a981029e843e8161534";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

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

async function socketJson(
  socketPath: string,
  requestPath: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { error?: { type?: string } } }> {
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
    }, async (response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { type?: string } } });
      } catch (error) { reject(error); }
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxCaptureChars: 100_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function waitTerminal(taskId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await taskStatus(taskId) as Record<string, unknown>;
    if (!new Set(["queued", "running"]).has(String(current.status))) return current;
    await sleep(100);
  }
  throw new Error(`dynamic real-profile task did not terminate: ${taskId}`);
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const fn = (raw as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return [];
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? [name] : [];
  }).sort();
}

const temp = await mkdtemp(path.join(os.tmpdir(), "codex-harness-dynamic-real-profile-"));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const harnessRoot = path.resolve(process.env.CODEX_HARNESS_FIXTURE_HARNESS_ROOT ?? "/home/zyc14588/deepseek-harness");
const harnessCli = path.join(harnessRoot, "apps", "cli", "lib", "bin.js");
const harnessBuildRoot = path.dirname(harnessCli);
const repo = path.join(temp, "repo");
const stateRoot = path.join(temp, "state");
const dshHome = path.join(temp, "dsh-home");
const configPath = path.join(temp, "config.json");
const flashTaskId = "dynamic-flash-profile-task";
const proTaskId = "dynamic-pro-profile-task";
const flashTargetPath = "dynamic-flash-probe.txt";
const proTargetPath = "dynamic-pro-probe.txt";
const providerKey = "dynamic-mock-key-never-persisted";
interface ProviderRequestEvidence {
  model: string;
  ordinal: number;
  toolNames: string[];
  toolChoicePresent: boolean;
  thinkingType?: unknown;
  reasoningEffortPresent: boolean;
  reasoningEffort?: unknown;
  replayedReasoningCount: number;
}
const providerRequests: ProviderRequestEvidence[] = [];
const flashRequests: ProviderRequestEvidence[] = [];
const proRequests: ProviderRequestEvidence[] = [];
const proReasoning = [
  "Inspect the lease and create the requested file with the native shell tool.",
  "The leased file now exists; verify its exact content with another native tool call.",
  "Both tool results are present and the bounded change is ready for review.",
];
let providerFailure: string | undefined;
let providerPort = 0;

function assistantReasoning(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    return message.role === "assistant"
      && Array.isArray(message.tool_calls)
      && typeof message.reasoning_content === "string"
      ? [message.reasoning_content]
      : [];
  });
}

function toolResultSummaries(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    if (message.role !== "tool") return [];
    return [typeof message.content === "string" ? message.content.slice(0, 1_000) : JSON.stringify(message.content).slice(0, 1_000)];
  });
}

function sendToolCall(
  response: ServerResponse,
  model: string,
  responseId: string,
  callId: string,
  command: string,
  reasoning?: string,
): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (reasoning !== undefined) {
    response.write(`data: ${JSON.stringify({
      id: responseId,
      model,
      choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: responseId,
    model,
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 200, completion_tokens: 30, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200 },
  })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendText(response: ServerResponse, model: string, responseId: string, content: string, reasoning?: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (reasoning !== undefined) {
    response.write(`data: ${JSON.stringify({
      id: responseId,
      model,
      choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: responseId,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 220, completion_tokens: 12, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 120 },
  })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

const provider = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.endsWith("/chat/completions")) return json(response, 404, { error: "not found" });
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`, "task credential reached the Provider or upstream authorization was not injected");
    const body = await readBody(request);
    const model = String(body.model ?? "");
    const names = toolNames(body);
    const replayed = assistantReasoning(body);
    const destination = model === "deepseek-v4-flash" ? flashRequests : proRequests;
    const ordinal = destination.length + 1;
    const evidence: ProviderRequestEvidence = {
      model,
      ordinal,
      toolNames: names,
      toolChoicePresent: Object.prototype.hasOwnProperty.call(body, "tool_choice"),
      ...(body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)
        ? { thinkingType: (body.thinking as Record<string, unknown>).type }
        : {}),
      reasoningEffortPresent: Object.prototype.hasOwnProperty.call(body, "reasoning_effort"),
      ...(body.reasoning_effort === undefined ? {} : { reasoningEffort: body.reasoning_effort }),
      replayedReasoningCount: replayed.length,
    };
    destination.push(evidence);
    providerRequests.push(evidence);
    if (process.env.CODEX_HARNESS_DYNAMIC_TRACE === "1") {
      process.stderr.write(`[dynamic ${model} request ${ordinal}] tool results: ${JSON.stringify(toolResultSummaries(body))}\n`);
    }

    if (model === "deepseek-v4-flash") {
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
      assert.ok(names.includes("bash"), `Flash provider request omitted bash: ${JSON.stringify(names)}`);
      if (ordinal <= 2) assert.equal(body.tool_choice, "required", `Flash request ${ordinal} was not forced before a diff`);
      else assert.equal(Object.prototype.hasOwnProperty.call(body, "tool_choice"), false, `Flash request ${ordinal} retained tool_choice after a diff`);
      if (ordinal === 1) {
        const durable = JSON.parse(await readFile(path.join(stateRoot, "tasks", flashTaskId, "task.json"), "utf8")) as Record<string, unknown>;
        assert.ok(Number(durable.minimalMutationForceCount ?? 0) >= 1, "force counter was not durable before provider POST");
        return sendToolCall(response, model, "dynamic-flash-1", "call-flash-inspect", `test ! -e ${flashTargetPath}`);
      }
      if (ordinal === 2) return sendToolCall(response, model, "dynamic-flash-2", "call-flash-write", `printf 'dynamic-flash-profile\\n' > ${flashTargetPath}`);
      if (ordinal === 3) return sendToolCall(response, model, "dynamic-flash-3", "call-flash-verify", `test "$(cat ${flashTargetPath})" = dynamic-flash-profile && git diff --check`);
      if (ordinal === 4) return sendText(response, model, "dynamic-flash-4", "Implemented and verified the exact leased Flash file.");
      throw new Error(`unexpected Flash request ${ordinal}`);
    }

    assert.equal(model, "deepseek-v4-pro", `unexpected model ${model}`);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
    assert.equal(Object.prototype.hasOwnProperty.call(body, "tool_choice"), false);
    assert.ok(names.includes("bash"), `Pro provider request omitted bash: ${JSON.stringify(names)}`);
    assert.deepEqual(replayed, proReasoning.slice(0, Math.max(0, ordinal - 1)), `Pro request ${ordinal} did not fully replay reasoning history`);
    if (ordinal === 1) return sendToolCall(response, model, "dynamic-pro-1", "call-pro-write", `printf 'dynamic-pro-profile\\n' > ${proTargetPath}`, proReasoning[0]);
    if (ordinal === 2) return sendToolCall(response, model, "dynamic-pro-2", "call-pro-verify", `test "$(cat ${proTargetPath})" = dynamic-pro-profile && git diff --check`, proReasoning[1]);
    if (ordinal === 3) return sendText(response, model, "dynamic-pro-3", "Implemented and verified the exact leased Pro file.", proReasoning[2]);
    throw new Error(`unexpected Pro request ${ordinal}`);
  } catch (error) {
    providerFailure = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) json(response, 500, { error: providerFailure });
    else response.destroy(error instanceof Error ? error : new Error(providerFailure));
  }
});

let monitorStarted = false;
try {
  const harnessCommit = await git(harnessRoot, ["rev-parse", "HEAD"]);
  assert.equal(harnessCommit, EXPECTED_HARNESS_COMMIT, "dynamic fixture Harness commit changed");
  const harnessStatus = await git(harnessRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
  assert.equal(harnessStatus, "", "dynamic fixture requires a clean fixed Harness checkout");
  const harnessBuildSha256 = await sha256PathTree(harnessBuildRoot);
  const bwrapIdentity = await sha256Executable("/usr/bin/bwrap");

  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "dynamic real managed-profile fixture\n");
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "dynamic-fixture@example.invalid"]);
  await git(repo, ["config", "user.name", "Dynamic Fixture"]);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-qm", "fixture"]);

  providerPort = await listen(provider);
  const monitorProbe = http.createServer((_request, response) => response.end());
  const monitorPort = await listen(monitorProbe);
  await closeServer(monitorProbe);
  const providerKeyPath = path.join(stateRoot, "secrets", "provider.key");
  await mkdir(path.dirname(providerKeyPath), { recursive: true });
  await writeFile(providerKeyPath, `${providerKey}\n`, { mode: 0o600 });
  await mkdir(path.join(dshHome, "profiles"), { recursive: true });
  await cp("/home/zyc14588/.dsh/profiles/node_modules", path.join(dshHome, "profiles", "node_modules"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 7,
    harnessRoot,
    harnessCli,
    harnessBuildRoot,
    harnessProfile: "headless",
    harnessMinimalProfile: "codex-minimal-headless",
    dshHome,
    stateRoot,
    allowedRepoRoots: [temp],
    passEnvironment: ["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR"],
    defaultRuntimeSeconds: 120,
    maxRuntimeSeconds: 300,
    logTailChars: 40_000,
    pinnedHarnessCommit: harnessCommit,
    pinnedHarnessBuildSha256: harnessBuildSha256,
    enforceHarnessPin: true,
    enforceHarnessBuildHash: true,
    requireCleanRepoAtStart: true,
    allowDirtyHarnessCheckout: false,
    controller: {
      requirePlan: true,
      preferMinimalHarness: true,
      splitMemory: { enabled: true, minSamplesForEnforcement: 1 },
    },
    monitor: {
      enabled: true,
      host: "127.0.0.1",
      port: monitorPort,
      autoStart: true,
      charsPerEstimatedToken: 4,
      pricingAsOf: "dynamic mock provider",
      pricing: {},
      currency: { primary: "CNY", showUsd: false, usdToCnyRate: null, fxAsOf: "fixture", fxSource: "fixture" },
    },
    provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKeyFile: providerKeyPath },
    harnessIsolation: {
      bubblewrapBinary: bwrapIdentity.realpath,
      bubblewrapSha256: bwrapIdentity.sha256,
      relayPort: 43_128,
      rejectEnvFiles: true,
    },
    llamaCpp: { enabled: false, fallbackEnabled: false },
  }, null, 2)}\n`, { mode: 0o600 });

  const render = await runProcess("python3", [
    path.join(packageRoot, "scripts", "render-minimal-harness.py"), "install",
    "--template-root", path.join(packageRoot, "harness", "minimal"),
    "--profile-dir", path.join(dshHome, "profiles", "codex-minimal-headless"),
    "--preset-dir", path.join(dshHome, ".agent-presets", "codex-bridge-minimal"),
    "--runtime", packageRoot,
    "--config", configPath,
    "--node", process.execPath,
  ], { timeoutMs: 30_000, maxCaptureChars: 100_000 });
  assert.equal(render.code, 0, render.stderr || render.stdout);

  const composition = await runProcess(process.execPath, [harnessCli, "--profile", "codex-minimal-headless", "--dump-config"], {
    cwd: harnessRoot,
    env: { ...process.env, DSH_HOME: dshHome },
    timeoutMs: 60_000,
    maxCaptureChars: 300_000,
  });
  assert.equal(composition.code, 0, composition.stderr || composition.stdout);
  const compositionInspection = inspectMinimalProfileComposition(composition.stdout, composition.stderr);
  assert.equal(compositionInspection.ok, true, JSON.stringify(compositionInspection));

  process.env.CODEX_HARNESS_CONFIG = configPath;
  process.env.DEEPSEEK_API_KEY = "parent-provider-secret-must-not-reach-harness";
  process.env.GITHUB_TOKEN = "parent-github-secret-must-not-reach-harness";
  await createControllerPlan({
    repoRoot: repo,
    planId: "dynamic-flash-profile-plan",
    leaves: [{
      id: "dynamic-flash-profile",
      objective: `Create exactly ${flashTargetPath} containing the line dynamic-flash-profile. Inspect first, mutate with a model-visible tool, verify with another real tool call, and do not change any other path.`,
      executor: "harness",
      model: "deepseek-v4-flash",
      complexity: "small",
      harnessMode: "minimal",
      harnessWritePaths: [flashTargetPath],
      acceptanceCriteria: [`${flashTargetPath} contains exactly dynamic-flash-profile`],
      verificationCommands: [`test "$(cat ${flashTargetPath})" = dynamic-flash-profile`],
      budget: { maxApiCalls: 6, maxInputTokens: 100_000, maxOutputTokens: 10_000, maxCostCny: 5 },
    }],
  });
  await startTask({ planId: "dynamic-flash-profile-plan", leafId: "dynamic-flash-profile", taskId: flashTaskId });
  monitorStarted = true;
  const flashTerminal = await waitTerminal(flashTaskId);
  const flashStored = await loadTask(await loadConfig(), flashTaskId);
  assert.equal(providerFailure, undefined, providerFailure);
  assert.equal(flashTerminal.status, "completed", JSON.stringify(flashTerminal));
  assert.deepEqual(flashTerminal.changedPaths, [flashTargetPath]);
  assert.equal(flashRequests.length, 4, JSON.stringify(flashRequests));
  assert.ok(flashRequests.every((entry) => entry.thinkingType === "disabled" && !entry.reasoningEffortPresent));
  assert.ok(Number(flashTerminal.minimalMutationForceCount ?? 0) >= 2, JSON.stringify(flashTerminal));
  assert.ok(Number(flashTerminal.toolProtocolNativeCallCount ?? 0) >= 3, JSON.stringify(flashTerminal));
  assert.ok(Array.isArray(flashTerminal.minimalRunnerVisibleTools) && flashTerminal.minimalRunnerVisibleTools.includes("bash"));
  assert.ok(Array.isArray(flashTerminal.minimalRunnerVisibleTools) && flashTerminal.minimalRunnerVisibleTools.includes("str_replace_editor"));
  assert.deepEqual(flashTerminal.minimalRunnerVisibleTools, flashTerminal.minimalAssembledTools);
  const flashEvidence = flashTerminal.minimalRequestEvidence as Array<Record<string, unknown>>;
  assert.equal(flashEvidence.length, 4, JSON.stringify(flashEvidence));
  const flashPrimary = flashEvidence.find((entry) => entry.purpose === "primary_mutation");
  assert.ok(flashPrimary, JSON.stringify(flashEvidence));
  assert.deepEqual(flashPrimary.adapterToolNames, flashPrimary.wireToolNames);
  assert.deepEqual(flashPrimary.wireToolNames, flashPrimary.proxyParsedToolNames);
  assert.equal(flashPrimary.policyApplied, true);
  assert.equal(flashStored.executionAttempts?.[0]?.thinkingPolicy?.thinkingType, "disabled");
  assert.equal(flashStored.providerRequestOrdinal, 4);
  assert.equal(flashStored.thinkingRequestEvidence?.length, 4);
  assert.equal(flashStored.reasoningReplayRequirements?.length ?? 0, 0);
  assert.doesNotMatch(JSON.stringify(flashEvidence), /dynamic-mock-key-never-persisted|Create exactly|dynamic-flash-profile\. Inspect/u);

  await createControllerPlan({
    repoRoot: repo,
    planId: "dynamic-pro-profile-plan",
    leaves: [{
      id: "dynamic-pro-profile",
      objective: `Create exactly ${proTargetPath} containing the line dynamic-pro-profile. Use a real mutation tool, verify with a second real tool call, and do not change any other path.`,
      executor: "harness",
      model: "deepseek-v4-pro",
      complexity: "large",
      harnessMode: "minimal",
      harnessWritePaths: [proTargetPath],
      acceptanceCriteria: [`${proTargetPath} contains exactly dynamic-pro-profile`],
      verificationCommands: [`test "$(cat ${proTargetPath})" = dynamic-pro-profile`],
      budget: { maxApiCalls: 6, maxInputTokens: 100_000, maxOutputTokens: 10_000, maxCostCny: 5 },
    }],
  });
  await startTask({ planId: "dynamic-pro-profile-plan", leafId: "dynamic-pro-profile", taskId: proTaskId });
  const proTerminal = await waitTerminal(proTaskId);
  const config = await loadConfig();
  const proStored = await loadTask(config, proTaskId);
  assert.equal(providerFailure, undefined, providerFailure);
  assert.equal(proTerminal.status, "completed", JSON.stringify(proTerminal));
  assert.deepEqual(proTerminal.changedPaths, [proTargetPath]);
  assert.equal(proRequests.length, 3, JSON.stringify(proRequests));
  assert.ok(proRequests.every((entry) => entry.thinkingType === "enabled"
    && entry.reasoningEffort === "high"
    && !entry.toolChoicePresent));
  assert.deepEqual(proRequests.map((entry) => entry.replayedReasoningCount), [0, 1, 2]);
  assert.ok(Number(proTerminal.toolProtocolNativeCallCount ?? 0) >= 2, JSON.stringify(proTerminal));
  assert.equal(proStored.executionAttempts?.[0]?.thinkingPolicy?.thinkingType, "enabled");
  assert.equal(proStored.providerRequestOrdinal, 3);
  assert.equal(proStored.thinkingRequestEvidence?.length, 3);
  assert.equal(proStored.reasoningReplayRequirements?.length, 2);
  assert.deepEqual(proStored.reasoningReplayRequirements?.map((entry) => entry.replayCount), [2, 1]);
  assert.doesNotMatch(JSON.stringify(proStored.reasoningReplayRequirements), new RegExp(proReasoning.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "u"));

  const injectionTaskId = "dynamic-missing-replay-injection";
  const injectionFamily = "thinking-replay-failure-injection";
  const injectionAdvice = await adviseSplit(config, repo, {
    taskFamily: injectionFamily,
    requestedExecutor: "harness",
    executor: "harness",
    model: "deepseek-v4-pro",
    harnessMode: "standard",
    mode: "implementation",
    proposedComplexity: "medium",
    defaultBudget: proStored.budget,
  });
  const injectionAttempt = createExecutionAttempt("harness", "deepseek-v4-pro", 1, new Date().toISOString());
  assert.ok(injectionAttempt.id);
  const seededCapture = captureReasoningRequirement(
    "application/json",
    Buffer.from(JSON.stringify({ choices: [{ index: 0, message: {
      role: "assistant",
      reasoning_content: "real response retained only as an integrity hash",
      tool_calls: [{ id: "call-injected-replay", type: "function", function: { name: "bash", arguments: "{}" } }],
    } }] })),
    injectionAttempt.id,
    1,
    new Date().toISOString(),
  );
  assert.equal(seededCapture.ok, true);
  assert.ok(seededCapture.ok && seededCapture.requirement);
  const injection = structuredClone(proStored) as TaskRecord;
  for (const key of [
    "completedAt", "cleanedAt", "workerPid", "harnessPid", "exitCode", "resultSummary", "error",
    "reviewDecision", "reviewNotes", "reviewedPaths", "reviewedAt", "reviewedFingerprint",
    "verificationPassed", "verifiedAt", "verifiedCommands", "verifiedFingerprint", "bridgeCommit", "bridgeCommittedAt",
    "splitOutcomeRecordedAt", "splitOutcomeRevision", "infrastructureFailureKind", "infrastructureFailureDetails",
    "thinkingPolicyFailureAt", "worktreeRemoved", "branchDeleted",
  ] as const) delete (injection as unknown as Record<string, unknown>)[key];
  const injectionDir = taskDirectory(config, injectionTaskId);
  Object.assign(injection, {
    id: injectionTaskId,
    planId: "dynamic-failure-injection-plan",
    leafId: "dynamic-failure-injection",
    budgetGroupId: "dynamic-failure-injection-budget",
    taskFamily: injectionFamily,
    splitDecision: injectionAdvice.decision,
    harnessMode: "standard",
    model: "deepseek-v4-pro",
    status: "running",
    phase: "execution",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    executionAttempts: [injectionAttempt],
    providerRequestOrdinal: 0,
    thinkingRequestEvidence: [],
    reasoningReplayRequirements: [seededCapture.ok ? seededCapture.requirement : undefined].filter(Boolean),
    proxyToken: "d".repeat(48),
    upstreamBaseUrl: `http://127.0.0.1:${providerPort}`,
    changedPaths: [],
    outOfScopePaths: [],
    promptPath: path.join(injectionDir, "prompt.txt"),
    stdoutPath: path.join(injectionDir, "stdout.log"),
    stderrPath: path.join(injectionDir, "stderr.log"),
    usagePath: path.join(injectionDir, "usage.jsonl"),
  });
  await createTask(config, injection);
  const providerCallsBeforeInjection = providerRequests.length;
  const injectedResponse = await socketJson(
    monitorSocketPath(config),
    `/proxy/${injection.proxyToken}/v1/chat/completions`,
    injection.proxyToken!,
    {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "history intentionally omits the prior assistant tool-call message" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: true,
    },
  );
  assert.equal(injectedResponse.status, 502);
  assert.equal(injectedResponse.body.error?.type, "thinking_replay_state");
  assert.equal(providerRequests.length, providerCallsBeforeInjection, "failure injection reached the Provider");
  const failedInjection = await loadTask(config, injectionTaskId);
  assert.equal(failedInjection.infrastructureFailureKind, "thinking_replay_state");
  assert.equal(failedInjection.providerRequestOrdinal, 0);
  const injectionUsage = await usageForBudgetGroup(config, injection.budgetGroupId);
  assert.equal(injectionUsage.apiCalls, 0);
  assert.equal(injectionUsage.inputTokens + injectionUsage.estimatedInputTokens, 0);
  assert.equal(injectionUsage.outputTokens + injectionUsage.estimatedOutputTokens, 0);
  const injectionProfile = await recordTaskSplitOutcome(config, failedInjection, "execution");
  assert.equal(injectionProfile?.sampleCount, 0);
  assert.equal(injectionProfile?.recommendedLeafScale, 1);
  const adviceAfterInjection = await adviseSplit(config, repo, {
    taskFamily: injectionFamily,
    requestedExecutor: "harness",
    executor: "harness",
    model: "deepseek-v4-pro",
    harnessMode: "standard",
    mode: "implementation",
    proposedComplexity: "medium",
    defaultBudget: proStored.budget,
  });
  assert.equal(adviceAfterInjection.decision.sampleCount, injectionAdvice.decision.sampleCount);
  assert.equal(adviceAfterInjection.decision.recommendedLeafScale, injectionAdvice.decision.recommendedLeafScale);
  assert.equal(adviceAfterInjection.decision.recommendedComplexity, injectionAdvice.decision.recommendedComplexity);
  assert.equal(adviceAfterInjection.decision.recommendedMaxInputTokens, injectionAdvice.decision.recommendedMaxInputTokens);
  assert.equal(adviceAfterInjection.decision.recommendedMaxOutputTokens, injectionAdvice.decision.recommendedMaxOutputTokens);
  await updateTask(config, injectionTaskId, (current) => {
    current.status = "failed";
    current.phase = "completed";
    current.completedAt = new Date().toISOString();
    current.error = current.infrastructureFailureDetails ?? "expected missing reasoning replay failure";
    const active = current.executionAttempts?.at(-1);
    if (active !== undefined) {
      active.completedAt = current.completedAt;
      active.outcome = "failed";
      active.error = current.error;
    }
  });

  const result = {
    result: "PASS",
    fixture: "real-managed-profile-multiturn-thinking-policy-mock-provider",
    harnessCommit,
    harnessBuildSha256,
    composition: compositionInspection,
    requestCount: providerRequests.length,
    providerRequests,
    flash: {
      status: flashTerminal.status,
      changedPaths: flashTerminal.changedPaths,
      requestCount: flashRequests.length,
      minimalMutationForceCount: flashTerminal.minimalMutationForceCount,
      toolProtocolNativeCallCount: flashTerminal.toolProtocolNativeCallCount,
      attemptPolicy: flashStored.executionAttempts?.[0]?.thinkingPolicy,
    },
    pro: {
      status: proTerminal.status,
      changedPaths: proTerminal.changedPaths,
      requestCount: proRequests.length,
      toolProtocolNativeCallCount: proTerminal.toolProtocolNativeCallCount,
      attemptPolicy: proStored.executionAttempts?.[0]?.thinkingPolicy,
      replayRequirements: proStored.reasoningReplayRequirements,
    },
    failureInjection: {
      responseStatus: injectedResponse.status,
      failureKind: failedInjection.infrastructureFailureKind,
      providerCalls: providerRequests.length - providerCallsBeforeInjection,
      inputTokens: injectionUsage.inputTokens + injectionUsage.estimatedInputTokens,
      outputTokens: injectionUsage.outputTokens + injectionUsage.estimatedOutputTokens,
      splitSampleCount: injectionProfile?.sampleCount,
      recommendedLeafScale: injectionProfile?.recommendedLeafScale,
      recommendedComplexity: adviceAfterInjection.decision.recommendedComplexity,
      recommendedMaxInputTokens: adviceAfterInjection.decision.recommendedMaxInputTokens,
      recommendedMaxOutputTokens: adviceAfterInjection.decision.recommendedMaxOutputTokens,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await cleanupTask(flashTaskId, true, true);
  await cleanupTask(proTaskId, true, true);
} finally {
  if (monitorStarted) {
    try { await monitorStop(); } catch { /* best effort fixture cleanup */ }
  }
  await closeServer(provider);
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.CODEX_HARNESS_CONFIG;
  if (process.env.KEEP_CODEX_HARNESS_DYNAMIC_FIXTURE !== "1") await rm(temp, { recursive: true, force: true });
}
