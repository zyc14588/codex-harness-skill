import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareHarnessSandbox, cleanupHarnessSandbox } from "../harness-isolation.js";
import { sha256Executable } from "../process-identity.js";
import { ensureOperatorToken, monitorSocketPath } from "../security.js";
import { createTask, taskDirectory } from "../store.js";
import { createExecutionAttempt } from "../thinking-policy.js";
import type { TaskRecord } from "../types.js";
import { runProcess, sleep } from "../util.js";
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

async function reservePort(): Promise<number> {
  const server = http.createServer((_request, response) => response.end());
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([closed, sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForMonitor(port: number, child: ChildProcess, token: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`monitor exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch { /* still starting */ }
    await sleep(25);
  }
  throw new Error("monitor did not become ready");
}

async function consume(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

async function socketRaw(socketPath: string, requestPath: string, token: string, body: Buffer): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": body.length,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("Bubblewrap confines Harness read/network/process access while the one-task proxy remains usable", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-harness-isolation-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "task-worktree");
  const stateRoot = path.join(root, "state");
  const harnessRoot = path.join(root, "harness");
  const dshHome = path.join(root, "dsh-home");
  const hostSecretPath = path.join(root, "host-secret.txt");
  const fakeHarness = path.join(harnessRoot, "fake-harness.mjs");
  const configPath = path.join(root, "config.json");
  const taskId = "strong-isolation-task";
  const proxyToken = "b".repeat(48);
  const providerKey = "real-provider-secret-held-only-by-monitor";
  let providerCalls = 0;
  let providerAuthorized = false;
  let providerMaxTokens: unknown;
  const provider = http.createServer(async (request, response) => {
    const body = JSON.parse((await consume(request)).toString("utf8")) as Record<string, unknown>;
    providerCalls += 1;
    providerAuthorized = request.headers.authorization === `Bearer ${providerKey}`
      && request.headers.authorization !== `Bearer ${proxyToken}`;
    providerMaxTokens = body.max_tokens;
    json(response, 200, {
      id: "isolation-provider-response",
      model: "deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "isolated proxy ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 },
    });
  });
  const sentinel = spawn("/usr/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  sentinel.unref();
  assert.ok(sentinel.pid);
  let monitor: ChildProcess | undefined;
  let preparedRoot: string | undefined;
  try {
    const providerPort = await listen(provider);
    await mkdir(repo, { recursive: true });
    assert.equal((await runProcess("/usr/bin/git", ["init", "-q"], { cwd: repo })).code, 0);
    assert.equal((await runProcess("/usr/bin/git", ["config", "user.email", "isolation@example.invalid"], { cwd: repo })).code, 0);
    assert.equal((await runProcess("/usr/bin/git", ["config", "user.name", "Isolation Test"], { cwd: repo })).code, 0);
    await writeFile(path.join(repo, "README.md"), "isolation fixture\n");
    assert.equal((await runProcess("/usr/bin/git", ["add", "README.md"], { cwd: repo })).code, 0);
    assert.equal((await runProcess("/usr/bin/git", ["commit", "-qm", "fixture"], { cwd: repo })).code, 0);
    assert.equal((await runProcess("/usr/bin/git", ["worktree", "add", "-q", "-b", "isolation-task", worktree, "HEAD"], { cwd: repo })).code, 0);

    await mkdir(harnessRoot, { recursive: true });
    await mkdir(path.join(dshHome, "profiles", "headless"), { recursive: true });
    await mkdir(path.join(dshHome, "profiles", "node_modules"), { recursive: true });
    await writeFile(hostSecretPath, "HOST_SECRET_MUST_NOT_BE_VISIBLE\n", { mode: 0o600 });
    await writeFile(fakeHarness, `
import { access, readFile, writeFile } from "node:fs/promises";
const report = {
  parentSecretInEnv: process.env.AUDIT_SECRET_SENTINEL !== undefined,
  githubSecretInEnv: process.env.GITHUB_TOKEN !== undefined,
  proxyCredentialShape: /^[a-f0-9]{48}$/.test(process.env.DEEPSEEK_API_KEY || ""),
  hostSecretReadable: true,
  hostPidVisible: true,
  directHostNetworkReachable: true,
  proxyStatus: 0,
  worktreeWrite: false,
};
try { await readFile(${JSON.stringify(hostSecretPath)}, "utf8"); } catch { report.hostSecretReadable = false; }
try { await access("/proc/${sentinel.pid}/stat"); } catch { report.hostPidVisible = false; }
try { await fetch("http://127.0.0.1:${providerPort}/direct-host-network-probe", { signal: AbortSignal.timeout(1000) }); } catch { report.directHostNetworkReachable = false; }
const response = await fetch(process.env.DEEPSEEK_BASE_URL + "/v1/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "isolation proxy probe" }], thinking: { type: "disabled" }, max_tokens: 400000 }),
});
report.proxyStatus = response.status;
await response.text();
await writeFile(${JSON.stringify(path.join(worktree, "isolation-report.json"))}, JSON.stringify(report), "utf8");
report.worktreeWrite = true;
await writeFile(${JSON.stringify(path.join(worktree, "isolation-report.json"))}, JSON.stringify(report), "utf8");
`, { mode: 0o700 });
    await chmod(fakeHarness, 0o700);

    const bwrap = await sha256Executable("/usr/bin/bwrap");
    const base = testConfig(stateRoot);
    const monitorPort = await reservePort();
    const config = {
      ...base,
      schemaVersion: 7 as const,
      harnessRoot,
      harnessCli: fakeHarness,
      dshHome,
      stateRoot,
      allowedRepoRoots: [root],
      passEnvironment: ["PATH"],
      monitor: { ...base.monitor, enabled: true, autoStart: false, port: monitorPort },
      provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKeyFile: path.join(stateRoot, "secrets", "provider.key") },
      harnessIsolation: { bubblewrapBinary: bwrap.realpath, bubblewrapSha256: bwrap.sha256, relayPort: 49_152, rejectEnvFiles: true as const },
      llamaCpp: { ...base.llamaCpp, enabled: false, fallbackEnabled: false },
    };
    await mkdir(path.dirname(config.provider.apiKeyFile), { recursive: true, mode: 0o700 });
    await writeFile(config.provider.apiKeyFile, `${providerKey}\n`, { mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const operatorToken = await ensureOperatorToken(config);

    const taskDir = taskDirectory(config, taskId);
    const now = new Date().toISOString();
    const task: TaskRecord = {
      schemaVersion: 6,
      id: taskId,
      planId: "isolation-plan",
      leafId: "isolation-leaf",
      budgetGroupId: taskId,
      requestedExecutor: "harness",
      executor: "harness",
      effectiveExecutor: "harness",
      routingReason: "isolation test",
      complexity: "small",
      harnessMode: "standard",
      dependsOn: [],
      toolCapabilities: [],
      taskFamily: "security/harness-isolation",
      splitDecision: {
        memorySchemaVersion: 4, memoryKey: "isolation", taskFamily: "security/harness-isolation", memoryRevision: 0,
        sampleCount: 0, ignoredLegacySampleCount: 0, confidence: 0, recommendedLeafScale: 1,
        recommendedComplexity: "small", recommendedMaxInputTokens: 900_000, recommendedMaxOutputTokens: 500_000,
        anomalyRate: 0, rationale: ["security test"], chosenComplexity: "small", chosenMaxInputTokens: 900_000, chosenMaxOutputTokens: 500_000,
      },
      mode: "analysis",
      objective: "prove strong Harness isolation",
      repoRoot: repo,
      baseRef: "HEAD",
      baseCommit: (await runProcess("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
      startingHeadCommit: (await runProcess("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
      branchName: "isolation-task",
      worktreePath: worktree,
      harnessWritePaths: ["isolation-report.json"],
      codexWritePaths: [],
      acceptanceCriteria: ["all isolation probes pass"],
      contextFiles: [],
      verificationCommands: [],
      budget: {
        gatePolicy: "input_output_tokens", ceilingPolicy: "unbounded", enforcement: "hard",
        maxApiCalls: 2, maxInputTokens: 900_000, maxOutputTokens: 500_000, maxCostCny: 10, maxCostUsd: 2,
      },
      model: "deepseek-v4-flash",
      status: "running",
      createdAt: now,
      startedAt: now,
      runtimeSeconds: 30,
      promptPath: path.join(taskDir, "prompt.md"),
      stdoutPath: path.join(taskDir, "stdout.log"),
      stderrPath: path.join(taskDir, "stderr.log"),
      usagePath: path.join(taskDir, "usage.ndjson"),
      proxyToken,
      upstreamBaseUrl: config.provider.baseUrl,
      changedPaths: [],
      outOfScopePaths: [],
      executionAttempts: [createExecutionAttempt("harness", "deepseek-v4-flash", 1, now)],
      providerRequestOrdinal: 0,
      thinkingRequestEvidence: [],
      reasoningReplayRequirements: [],
    };
    await createTask(config, task);
    await writeFile(task.promptPath, "bounded isolation test\n", { mode: 0o600 });

    const daemonPath = fileURLToPath(new URL("../monitor-daemon.js", import.meta.url));
    monitor = spawn(process.execPath, [daemonPath], {
      env: { ...process.env, CODEX_HARNESS_CONFIG: configPath },
      stdio: "ignore",
    });
    await waitForMonitor(config.monitor.port, monitor, operatorToken);
    const socketInfo = await stat(monitorSocketPath(config));
    assert.equal(socketInfo.mode & 0o777, 0o600);
    assert.equal((await fetch(`http://127.0.0.1:${config.monitor.port}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${config.monitor.port}/api/llama/server/start`, { method: "POST" })).status, 401);
    assert.equal(await socketRaw(monitorSocketPath(config), `/proxy/${proxyToken}/v1/chat/completions`, proxyToken, Buffer.from("{malformed")), 400);
    assert.equal(providerCalls, 0, "malformed JSON reached the Provider");

    process.env.AUDIT_SECRET_SENTINEL = "parent-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    process.env.DEEPSEEK_API_KEY = providerKey;
    const prepared = await prepareHarnessSandbox(config, task, {
      command: process.execPath,
      prefixArgs: [fakeHarness],
      source: fakeHarness,
    }, "headless", "deepseek-v4-flash");
    preparedRoot = prepared.sandboxRoot;
    const result = await runProcess(prepared.command, prepared.args, {
      cwd: worktree,
      env: prepared.env,
      timeoutMs: 30_000,
      maxCaptureChars: 50_000,
      killProcessGroup: true,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(path.join(worktree, "isolation-report.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(report, {
      parentSecretInEnv: false,
      githubSecretInEnv: false,
      proxyCredentialShape: true,
      hostSecretReadable: false,
      hostPidVisible: false,
      directHostNetworkReachable: false,
      proxyStatus: 200,
      worktreeWrite: true,
    });
    assert.equal(providerCalls, 1);
    assert.equal(providerAuthorized, true, "proxy failed to replace the task Authorization header with the real Provider credential");
    assert.equal(providerMaxTokens, 384_000, "single-request output was not clamped to the model capability");
  } finally {
    delete process.env.AUDIT_SECRET_SENTINEL;
    delete process.env.GITHUB_TOKEN;
    delete process.env.DEEPSEEK_API_KEY;
    if (preparedRoot) await cleanupHarnessSandbox(preparedRoot);
    if (monitor) await stopChild(monitor);
    await closeServer(provider);
    if (sentinel.pid) {
      try { process.kill(-sentinel.pid, "SIGKILL"); } catch { try { process.kill(sentinel.pid, "SIGKILL"); } catch { /* gone */ } }
    }
    await rm(root, { recursive: true, force: true });
  }
});
