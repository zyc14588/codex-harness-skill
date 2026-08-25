import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareHarnessSandbox, cleanupHarnessSandbox } from "../harness-isolation.js";
import { sha256Executable } from "../process-identity.js";
import { freezeHostResourceProfile } from "../resource-controls.js";
import { ensureOperatorToken, monitorSocketPath } from "../security.js";
import { createTask, taskDirectory, updateTask } from "../store.js";
import { createExecutionAttempt } from "../thinking-policy.js";
import { runProcess, sleep } from "../util.js";
import { testConfig } from "./test-config.js";
async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return address.port;
}
async function closeServer(server) {
    if (!server.listening)
        return;
    await new Promise((resolve) => server.close(() => resolve()));
}
async function reservePort() {
    const server = http.createServer((_request, response) => response.end());
    const port = await listen(server);
    await closeServer(server);
    return port;
}
async function stopChild(child) {
    if (child.exitCode !== null)
        return;
    const closed = new Promise((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([closed, sleep(3_000)]);
    if (child.exitCode === null)
        child.kill("SIGKILL");
}
async function waitForMonitor(port, child, token) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error(`monitor exited before readiness with code ${child.exitCode}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (response.ok)
                return;
        }
        catch { /* still starting */ }
        await sleep(25);
    }
    throw new Error("monitor did not become ready");
}
async function consume(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}
function json(response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
    response.end(body);
}
async function socketRaw(socketPath, requestPath, token, body, options = {}) {
    return await new Promise((resolve, reject) => {
        const request = http.request({
            socketPath,
            path: requestPath,
            method: options.method ?? "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": options.contentType ?? "application/json",
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
async function processIdsContaining(marker) {
    const values = [];
    for (const entry of await readdir("/proc")) {
        if (!/^\d+$/u.test(entry))
            continue;
        try {
            const commandLine = await readFile(`/proc/${entry}/cmdline`, "utf8");
            if (commandLine.includes(marker))
                values.push(Number(entry));
        }
        catch { /* process exited while scanning */ }
    }
    return values;
}
async function waitUntil(label, predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate())
            return;
        await sleep(25);
    }
    throw new Error(`timed out waiting for ${label}`);
}
async function fileExists(target) {
    try {
        await stat(target);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
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
    const toolProbe = path.join(worktree, "tool-probe.mjs");
    const configPath = path.join(root, "config.json");
    const taskId = "strong-isolation-task";
    const toolTaskId = "strong-isolation-tool-task";
    const proxyToken = "b".repeat(48);
    const adapterToken = "c".repeat(64);
    const toolToken = "d".repeat(64);
    const attemptStartedAt = new Date().toISOString();
    const attempt = createExecutionAttempt("harness", "deepseek-v4-flash", 1, attemptStartedAt);
    assert.ok(attempt.id);
    const providerKey = "real-provider-secret-held-only-by-monitor";
    let providerCalls = 0;
    let providerAuthorized = false;
    let providerMaxTokens;
    const provider = http.createServer(async (request, response) => {
        const body = JSON.parse((await consume(request)).toString("utf8"));
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
    let monitor;
    let preparedRoot;
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
        await writeFile(toolProbe, `
import http from "node:http";
import { access, readFile, writeFile } from "node:fs/promises";
const [reportPath] = process.argv.slice(2);
const report = {
  forbiddenEnvironmentNames: Object.keys(process.env).filter(name => name.startsWith("DEEPSEEK_") || name.startsWith("CODEX_HARNESS_")),
  procEnvironmentLeak: false,
  outerHarnessPidVisible: true,
  brokerSocketReachable: true,
  relayReachable: true,
  directProviderReachable: true,
  hostSecretReadable: true,
};
for (const entry of await (await import("node:fs/promises")).readdir("/proc")) {
  if (!/^\\d+$/.test(entry)) continue;
  try {
    const value = await readFile("/proc/" + entry + "/environ");
    if (value.includes(Buffer.from("DEEPSEEK_")) || value.includes(Buffer.from("CODEX_HARNESS_"))) report.procEnvironmentLeak = true;
  } catch {}
}
try { await access("/proc/${sentinel.pid}/stat"); } catch { report.outerHarnessPidVisible = false; }
try { await readFile(${JSON.stringify(hostSecretPath)}, "utf8"); } catch { report.hostSecretReadable = false; }
report.brokerSocketReachable = await new Promise(resolve => {
  const request = http.request({ socketPath: "/run/codex-harness-bridge/monitor.sock", path: "/", method: "POST" }, response => {
    response.resume(); response.once("end", () => resolve(true));
  });
  request.once("error", () => resolve(false)); request.end();
});
try {
  await fetch("http://127.0.0.1:49152/provider/untrusted/chat/completions", {
    method: "POST", headers: { authorization: "Bearer untrusted-tool", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "tool must not egress" }] }),
    signal: AbortSignal.timeout(1000),
  });
} catch { report.relayReachable = false; }
try { await fetch("http://127.0.0.1:${providerPort}/direct-tool-probe", { signal: AbortSignal.timeout(1000) }); }
catch { report.directProviderReachable = false; }
await writeFile(reportPath, JSON.stringify(report), "utf8");
`, { mode: 0o700 });
        await writeFile(fakeHarness, `
import { access, readFile, writeFile } from "node:fs/promises";
const report = {
  parentSecretInEnv: process.env.AUDIT_SECRET_SENTINEL !== undefined,
  githubSecretInEnv: process.env.GITHUB_TOKEN !== undefined,
  proxyCredentialShape: /^[a-f0-9]{48}$/.test(process.env.DEEPSEEK_API_KEY || ""),
  adapterCredentialShape: /^[a-f0-9]{64}$/.test(process.env.CODEX_HARNESS_ADAPTER_TOKEN || ""),
  toolCredentialShape: /^[a-f0-9]{64}$/.test(process.env.CODEX_HARNESS_TOOL_TOKEN || ""),
  capabilitiesSeparated: new Set([process.env.DEEPSEEK_API_KEY, process.env.CODEX_HARNESS_ADAPTER_TOKEN, process.env.CODEX_HARNESS_TOOL_TOKEN]).size === 3,
  secretBearingBaseUrl: (process.env.DEEPSEEK_BASE_URL || "").includes(process.env.DEEPSEEK_API_KEY || "missing"),
  hostSecretReadable: true,
  hostPidVisible: true,
  directHostNetworkReachable: true,
  sandboxRootPresent: process.env.CODEX_HARNESS_SANDBOX_ROOT === "/sandbox",
  promptFileReadable: false,
  proxyStatus: 0,
  worktreeWrite: false,
};
try { await readFile(${JSON.stringify(hostSecretPath)}, "utf8"); } catch { report.hostSecretReadable = false; }
try { await access("/proc/${sentinel.pid}/stat"); } catch { report.hostPidVisible = false; }
try { report.promptFileReadable = (await readFile(process.env.CODEX_HARNESS_PROMPT_FILE, "utf8")) === "bounded isolation test\\n"; } catch {}
try { await fetch("http://127.0.0.1:${providerPort}/direct-host-network-probe", { signal: AbortSignal.timeout(1000) }); } catch { report.directHostNetworkReachable = false; }
const response = await fetch(process.env.DEEPSEEK_BASE_URL + "/chat/completions", {
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
        const prlimit = await sha256Executable("/usr/bin/prlimit");
        const base = testConfig(stateRoot);
        const monitorPort = await reservePort();
        const config = {
            ...base,
            schemaVersion: 7,
            harnessRoot,
            harnessCli: fakeHarness,
            dshHome,
            stateRoot,
            allowedRepoRoots: [root],
            passEnvironment: ["PATH"],
            monitor: { ...base.monitor, enabled: true, autoStart: false, port: monitorPort },
            provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKeyFile: path.join(stateRoot, "secrets", "provider.key") },
            harnessIsolation: {
                bubblewrapBinary: bwrap.realpath,
                bubblewrapSha256: bwrap.sha256,
                relayPort: 49_152,
                rejectEnvFiles: true,
                resourceProfile: {
                    ...base.harnessIsolation.resourceProfile,
                    enforcement: "audit_only",
                    prlimitBinary: prlimit.realpath,
                    prlimitSha256: prlimit.sha256,
                },
                resourceProfiles: base.harnessIsolation.resourceProfiles,
            },
            llamaCpp: { ...base.llamaCpp, enabled: false, fallbackEnabled: false },
        };
        const frozenResourceProfile = freezeHostResourceProfile(config, "local_or_flash_trivial_small");
        attempt.resourceProfile = frozenResourceProfile;
        await mkdir(path.dirname(config.provider.apiKeyFile), { recursive: true, mode: 0o700 });
        await writeFile(config.provider.apiKeyFile, `${providerKey}\n`, { mode: 0o600 });
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        const operatorToken = await ensureOperatorToken(config);
        const taskDir = taskDirectory(config, taskId);
        const task = {
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
            resourceProfile: frozenResourceProfile,
            dependsOn: [],
            toolCapabilities: [],
            taskFamily: "security/harness-isolation",
            splitDecision: {
                memorySchemaVersion: 5, memoryKey: "isolation", taskFamily: "security/harness-isolation", memoryRevision: 0,
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
            createdAt: attemptStartedAt,
            startedAt: attemptStartedAt,
            runtimeSeconds: 30,
            promptPath: path.join(taskDir, "prompt.md"),
            stdoutPath: path.join(taskDir, "stdout.log"),
            stderrPath: path.join(taskDir, "stderr.log"),
            usagePath: path.join(taskDir, "usage.ndjson"),
            proxyToken,
            adapterToken,
            toolToken,
            upstreamBaseUrl: config.provider.baseUrl,
            changedPaths: [],
            outOfScopePaths: [],
            executionAttempts: [attempt],
            providerRequestOrdinal: 0,
            thinkingRequestEvidence: [],
            reasoningReplayRequirements: [],
        };
        await createTask(config, task);
        await writeFile(task.promptPath, "bounded isolation test\n", { mode: 0o600 });
        const toolAttempt = createExecutionAttempt("harness", "deepseek-v4-flash", 1, attemptStartedAt);
        toolAttempt.resourceProfile = frozenResourceProfile;
        assert.ok(toolAttempt.id);
        const toolTaskDir = taskDirectory(config, toolTaskId);
        const toolTask = {
            ...structuredClone(task),
            id: toolTaskId,
            leafId: "isolation-tool-leaf",
            budgetGroupId: toolTaskId,
            harnessMode: "minimal",
            objective: "prove brokered shell isolation",
            toolCapabilities: ["repository_read"],
            harnessWritePaths: ["tool-isolation-report.json"],
            promptPath: path.join(toolTaskDir, "prompt.md"),
            stdoutPath: path.join(toolTaskDir, "stdout.log"),
            stderrPath: path.join(toolTaskDir, "stderr.log"),
            usagePath: path.join(toolTaskDir, "usage.ndjson"),
            proxyToken: "e".repeat(48),
            adapterToken: "f".repeat(64),
            toolToken: "1".repeat(64),
            executionAttempts: [toolAttempt],
            providerRequestOrdinal: 0,
            thinkingRequestEvidence: [],
            reasoningReplayRequirements: [],
        };
        await createTask(config, toolTask);
        await writeFile(toolTask.promptPath, "bounded brokered-tool isolation test\n", { mode: 0o600 });
        const daemonPath = fileURLToPath(new URL("../monitor-daemon.js", import.meta.url));
        monitor = spawn(process.execPath, [daemonPath], {
            env: { ...process.env, CODEX_HARNESS_CONFIG: configPath },
            stdio: "ignore",
        });
        await waitForMonitor(config.monitor.port, monitor, operatorToken);
        const socketInfo = await stat(monitorSocketPath(config));
        assert.equal(socketInfo.mode & 0o777, 0o600);
        assert.equal((await fetch(`http://127.0.0.1:${config.monitor.port}/api/snapshot`)).status, 401);
        const rateLimitedAnonymous = await fetch(`http://127.0.0.1:${config.monitor.port}/api/llama/server/start`, { method: "POST" });
        assert.equal(rateLimitedAnonymous.status, 429);
        assert.ok(Number(rateLimitedAnonymous.headers.get("retry-after")) >= 1);
        const providerRoute = `/provider/${taskId}/${attempt.id}/chat/completions`;
        assert.equal(await socketRaw(monitorSocketPath(config), providerRoute, proxyToken, Buffer.alloc(0), { method: "GET" }), 405);
        assert.equal(await socketRaw(monitorSocketPath(config), providerRoute, proxyToken, Buffer.from("{}"), { contentType: "text/plain" }), 415);
        assert.equal(await socketRaw(monitorSocketPath(config), `${providerRoute}?suffix=1`, proxyToken, Buffer.from("{}")), 404);
        assert.equal(await socketRaw(monitorSocketPath(config), `${providerRoute}/suffix`, proxyToken, Buffer.from("{}")), 404);
        assert.equal(await socketRaw(monitorSocketPath(config), providerRoute, adapterToken, Buffer.from("{}")), 403);
        assert.equal(await socketRaw(monitorSocketPath(config), providerRoute, toolToken, Buffer.from("{}")), 403);
        assert.equal(await socketRaw(monitorSocketPath(config), providerRoute, proxyToken, Buffer.from("{malformed")), 400);
        assert.equal(providerCalls, 0, "malformed JSON reached the Provider");
        const adapterRoute = `/adapter-state/${taskId}/${attempt.id}/record-adapter-request`;
        assert.equal(await socketRaw(monitorSocketPath(config), adapterRoute, proxyToken, Buffer.from(JSON.stringify({ taskId, toolNames: [] }))), 403, "Provider capability was accepted by the Adapter-only state route");
        assert.equal(await socketRaw(monitorSocketPath(config), adapterRoute, toolToken, Buffer.from(JSON.stringify({ taskId, toolNames: [] }))), 403, "tool capability was accepted by the Adapter-only state route");
        assert.equal(providerCalls, 0);
        const toolRoute = `/tool-exec/${toolTaskId}/${toolAttempt.id}`;
        const toolBody = Buffer.from(JSON.stringify({ taskId: toolTaskId, tool: "bash", arguments: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(toolProbe)} ${JSON.stringify(path.join(worktree, "tool-isolation-report.json"))}`, timeout_seconds: 10 } }));
        assert.equal(await socketRaw(monitorSocketPath(config), toolRoute, toolTask.toolToken, toolBody, { method: "GET" }), 405);
        assert.equal(await socketRaw(monitorSocketPath(config), toolRoute, toolTask.toolToken, toolBody, { contentType: "text/plain" }), 415);
        assert.equal(await socketRaw(monitorSocketPath(config), toolRoute, toolTask.proxyToken, toolBody), 403, "Provider capability was accepted by the tool route");
        assert.equal(await socketRaw(monitorSocketPath(config), toolRoute, toolTask.adapterToken, toolBody), 403, "Adapter capability was accepted by the tool route");
        assert.equal(await socketRaw(monitorSocketPath(config), `${toolRoute}/suffix`, toolTask.toolToken, toolBody), 404, "tool route accepted an arbitrary suffix");
        assert.equal(await socketRaw(monitorSocketPath(config), toolRoute, toolTask.toolToken, toolBody), 200, "host-side brokered shell failed");
        const toolReport = JSON.parse(await readFile(path.join(worktree, "tool-isolation-report.json"), "utf8"));
        assert.deepEqual(toolReport, {
            forbiddenEnvironmentNames: [],
            procEnvironmentLeak: false,
            outerHarnessPidVisible: false,
            brokerSocketReachable: false,
            relayReachable: false,
            directProviderReachable: false,
            hostSecretReadable: false,
        });
        assert.equal(providerCalls, 0, "brokered tool isolation probe reached the real Provider");
        const snapshotRoute = `/adapter-state/${toolTaskId}/${toolAttempt.id}/publish-runner-snapshot`;
        const snapshotBody = Buffer.from(JSON.stringify({
            taskId: toolTaskId,
            presetId: "codex-bridge-minimal",
            visibleTools: ["bash", "str_replace_editor", "capability_catalog", "capability_enable"],
            assembledTools: ["bash", "str_replace_editor", "capability_catalog", "capability_enable"],
            requiredTools: ["bash", "str_replace_editor", "capability_catalog", "capability_enable"],
        }));
        assert.equal(await socketRaw(monitorSocketPath(config), snapshotRoute, toolTask.proxyToken, snapshotBody), 403);
        assert.equal(await socketRaw(monitorSocketPath(config), snapshotRoute, toolTask.toolToken, snapshotBody), 403);
        assert.equal(await socketRaw(monitorSocketPath(config), snapshotRoute, toolTask.adapterToken, snapshotBody), 200);
        assert.equal(providerCalls, 0, "Adapter state publication reached the real Provider");
        process.env.AUDIT_SECRET_SENTINEL = "parent-secret";
        process.env.GITHUB_TOKEN = "github-secret";
        process.env.DEEPSEEK_API_KEY = providerKey;
        const prepared = await prepareHarnessSandbox(config, task, {
            command: process.execPath,
            prefixArgs: [fakeHarness],
            source: fakeHarness,
        }, "headless", "deepseek-v4-flash");
        preparedRoot = prepared.sandboxRoot;
        assert.doesNotMatch(JSON.stringify({ args: prepared.args, env: prepared.env }), new RegExp(`${proxyToken}|${adapterToken}|${toolToken}`, "u"));
        const providerFileScan = await runProcess("/usr/bin/grep", ["-R", "-F", proxyToken, prepared.sandboxRoot], { timeoutMs: 10_000 });
        const adapterFileScan = await runProcess("/usr/bin/grep", ["-R", "-F", adapterToken, prepared.sandboxRoot], { timeoutMs: 10_000 });
        const toolFileScan = await runProcess("/usr/bin/grep", ["-R", "-F", toolToken, prepared.sandboxRoot], { timeoutMs: 10_000 });
        assert.equal(providerFileScan.code, 1, "Provider capability was persisted in a sandbox file");
        assert.equal(adapterFileScan.code, 1, "Adapter capability was persisted in a sandbox file");
        assert.equal(toolFileScan.code, 1, "tool capability was persisted in a sandbox file");
        const result = await runProcess(prepared.command, prepared.args, {
            cwd: worktree,
            env: prepared.env,
            input: prepared.capabilityInput,
            timeoutMs: 30_000,
            maxCaptureChars: 50_000,
            killProcessGroup: true,
        });
        assert.equal(result.code, 0, result.stderr || result.stdout);
        const report = JSON.parse(await readFile(path.join(worktree, "isolation-report.json"), "utf8"));
        assert.deepEqual(report, {
            parentSecretInEnv: false,
            githubSecretInEnv: false,
            proxyCredentialShape: true,
            adapterCredentialShape: true,
            toolCredentialShape: true,
            capabilitiesSeparated: true,
            secretBearingBaseUrl: false,
            hostSecretReadable: false,
            hostPidVisible: false,
            directHostNetworkReachable: false,
            sandboxRootPresent: true,
            promptFileReadable: true,
            proxyStatus: 200,
            worktreeWrite: true,
        });
        assert.equal(providerCalls, 1);
        assert.equal(providerAuthorized, true, "proxy failed to replace the task Authorization header with the real Provider credential");
        assert.equal(providerMaxTokens, 384_000, "single-request output was not clamped to the model capability");
        const auditFile = path.join(toolTaskDir, "brokered-tools-audit.ndjson");
        const completedBefore = (await readFile(auditFile, "utf8")).split("\n").filter((line) => line.includes('"result":"completed"')).length;
        const cancelledWrite = path.join(worktree, "cancelled-tool-wrote.txt");
        const cancelMarker = `codex-broker-cancel-${process.pid}-${Date.now()}`;
        const cancelBody = Buffer.from(JSON.stringify({
            taskId: toolTaskId,
            tool: "bash",
            arguments: {
                command: `sleep 7200 & sleep 2; printf 'late write\\n' > ${JSON.stringify(cancelledWrite)}; wait # ${cancelMarker}`,
                timeout_seconds: 7200,
            },
        }));
        const cancelledRequest = socketRaw(monitorSocketPath(config), toolRoute, toolTask.toolToken, cancelBody).catch(() => 0);
        await waitUntil("brokered cancellation process", async () => (await processIdsContaining(cancelMarker)).length > 0);
        await updateTask(config, toolTaskId, (current) => {
            current.status = "cancelled";
            current.completedAt = new Date().toISOString();
            current.error = "cancelled by lifecycle fixture";
        });
        await Promise.race([
            cancelledRequest,
            sleep(5_000).then(() => { throw new Error("cancelled brokered request did not settle"); }),
        ]);
        await waitUntil("cancelled brokered process-group quiescence", async () => (await processIdsContaining(cancelMarker)).length === 0);
        await sleep(2_200);
        assert.equal(await fileExists(cancelledWrite), false, "brokered command wrote after task cancellation");
        const nextAttempt = createExecutionAttempt("harness", "deepseek-v4-flash", 2, new Date().toISOString());
        nextAttempt.resourceProfile = frozenResourceProfile;
        assert.ok(nextAttempt.id);
        await updateTask(config, toolTaskId, (current) => {
            current.status = "running";
            delete current.completedAt;
            delete current.error;
            current.executionAttempts = [nextAttempt];
        });
        const attemptRoute = `/tool-exec/${toolTaskId}/${nextAttempt.id}`;
        const attemptMarker = `codex-broker-attempt-${process.pid}-${Date.now()}`;
        const attemptBody = Buffer.from(JSON.stringify({
            taskId: toolTaskId,
            tool: "bash",
            arguments: { command: `sleep 7200 # ${attemptMarker}`, timeout_seconds: 7200 },
        }));
        const staleAttemptRequest = socketRaw(monitorSocketPath(config), attemptRoute, toolTask.toolToken, attemptBody).catch(() => 0);
        await waitUntil("brokered stale-attempt process", async () => (await processIdsContaining(attemptMarker)).length > 0);
        const replacementAttempt = createExecutionAttempt("harness", "deepseek-v4-flash", 3, new Date().toISOString());
        replacementAttempt.resourceProfile = frozenResourceProfile;
        assert.ok(replacementAttempt.id);
        await updateTask(config, toolTaskId, (current) => { current.executionAttempts = [nextAttempt, replacementAttempt]; });
        await Promise.race([
            staleAttemptRequest,
            sleep(5_000).then(() => { throw new Error("stale-attempt brokered request did not settle"); }),
        ]);
        await waitUntil("stale-attempt process-group quiescence", async () => (await processIdsContaining(attemptMarker)).length === 0);
        const shutdownRoute = `/tool-exec/${toolTaskId}/${replacementAttempt.id}`;
        const shutdownMarker = `codex-broker-shutdown-${process.pid}-${Date.now()}`;
        const shutdownBody = Buffer.from(JSON.stringify({
            taskId: toolTaskId,
            tool: "bash",
            arguments: { command: `sleep 7200 # ${shutdownMarker}`, timeout_seconds: 7200 },
        }));
        const shutdownRequest = socketRaw(monitorSocketPath(config), shutdownRoute, toolTask.toolToken, shutdownBody).catch(() => 0);
        await waitUntil("brokered Monitor-shutdown process", async () => (await processIdsContaining(shutdownMarker)).length > 0);
        const monitorClosed = new Promise((resolve) => monitor.once("close", () => resolve()));
        monitor.kill("SIGTERM");
        await Promise.race([
            monitorClosed,
            sleep(8_000).then(() => { throw new Error("Monitor did not shut down after reclaiming brokered tools"); }),
        ]);
        await shutdownRequest;
        await waitUntil("Monitor-shutdown brokered process-group quiescence", async () => (await processIdsContaining(shutdownMarker)).length === 0);
        monitor = undefined;
        const completedAfter = (await readFile(auditFile, "utf8")).split("\n").filter((line) => line.includes('"result":"completed"')).length;
        assert.equal(completedAfter, completedBefore, "cancelled or stale brokered attempt wrote a completed audit event");
    }
    finally {
        delete process.env.AUDIT_SECRET_SENTINEL;
        delete process.env.GITHUB_TOKEN;
        delete process.env.DEEPSEEK_API_KEY;
        if (preparedRoot)
            await cleanupHarnessSandbox(preparedRoot);
        if (monitor)
            await stopChild(monitor);
        await closeServer(provider);
        if (sentinel.pid) {
            try {
                process.kill(-sentinel.pid, "SIGKILL");
            }
            catch {
                try {
                    process.kill(sentinel.pid, "SIGKILL");
                }
                catch { /* gone */ }
            }
        }
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=harness-isolation.test.js.map