import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolPayload, StdioMcpClient } from "./stdio-client.js";
import { runProcess, sleep } from "./util.js";
import { sha256Executable } from "./process-identity.js";
import { createPinnedHostResourceProfile } from "./resource-controls.js";
async function git(repo, args) {
    const result = await runProcess("git", args, { cwd: repo, timeoutMs: 20_000, maxCaptureChars: 200_000 });
    assert.equal(result.code, 0, result.stderr || result.stdout);
}
async function call(client, name, args, timeoutMs = 120_000) {
    return parseToolPayload(await client.callTool(name, args, timeoutMs));
}
async function expectToolError(client, name, args) {
    const result = await client.callTool(name, args);
    assert.equal(result.isError, true, `${name} should have returned an MCP tool error`);
    return parseToolPayload(result, true);
}
async function waitTerminal(client, taskId) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const status = await call(client, "harness_status", { taskId });
        if (!["queued", "running"].includes(String(status.status)))
            return status;
        await sleep(75);
    }
    throw new Error(`task did not finish: ${taskId}`);
}
async function reserveLoopbackPort() {
    const server = http.createServer((_request, response) => response.end());
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}
const temp = await mkdtemp(path.join(os.tmpdir(), "codex-harness-mcp-acceptance-"));
try {
    const repo = path.join(temp, "repo");
    const state = path.join(temp, "state");
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const dshHome = path.join(temp, "dsh-home");
    const minimalProfileName = "codex-minimal-headless";
    await mkdir(path.join(repo, "src/harness"), { recursive: true });
    await mkdir(path.join(repo, "src/pro"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "MCP acceptance fixture\n");
    await writeFile(path.join(repo, "src/harness/.gitkeep"), "");
    await writeFile(path.join(repo, "src/pro/.gitkeep"), "");
    await writeFile(path.join(repo, "tests/.gitkeep"), "");
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "mcp-acceptance@example.invalid"]);
    await git(repo, ["config", "user.name", "MCP Acceptance"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "fixture"]);
    const fakeDsh = fileURLToPath(new URL("../../scripts/fake-dsh.mjs", import.meta.url));
    const configPath = path.join(temp, "config.json");
    const providerKeyPath = path.join(state, "secrets", "provider.key");
    const bwrap = await sha256Executable("/usr/bin/bwrap");
    const resourceProfile = await createPinnedHostResourceProfile("audit_only");
    const monitorPort = await reserveLoopbackPort();
    await mkdir(path.join(dshHome, "profiles", "node_modules"), { recursive: true });
    await mkdir(path.join(dshHome, "profiles", "headless"), { recursive: true });
    await mkdir(path.dirname(providerKeyPath), { recursive: true, mode: 0o700 });
    await writeFile(providerKeyPath, "mcp-acceptance-provider-key-not-real-00000000\n", { mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify({
        schemaVersion: 7,
        harnessRoot: path.dirname(fakeDsh),
        harnessCli: fakeDsh,
        harnessProfile: "headless",
        harnessMinimalProfile: minimalProfileName,
        dshHome,
        stateRoot: state,
        allowedRepoRoots: [temp],
        passEnvironment: ["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR"],
        defaultRuntimeSeconds: 60,
        maxRuntimeSeconds: 300,
        logTailChars: 20_000,
        enforceHarnessPin: false,
        enforceHarnessBuildHash: false,
        requireCleanRepoAtStart: true,
        allowDirtyHarnessCheckout: false,
        controller: {
            requirePlan: true,
            maxLeavesPerPlan: 8,
            maxHarnessWriteLeases: 8,
            maxHarnessContextFiles: 8,
            maxHarnessAcceptanceCriteria: 8,
            maxHarnessObjectiveChars: 6_000,
            defaultHarnessBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "operator_bounded", enforcement: "hard", maxApiCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 0.36, maxCostUsd: 0.05 },
            maximumHarnessBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "operator_bounded", enforcement: "hard", maxApiCalls: 10, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostCny: 7.2, maxCostUsd: 1 },
            defaultProComplexBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "unbounded", enforcement: "hard", maxApiCalls: 120, maxInputTokens: 4_000_000, maxOutputTokens: 512_000, maxCostCny: 360, maxCostUsd: 50 },
            maxConcurrentHarnessGlobal: 4,
            maxConcurrentHarnessPerRepo: 3,
            preferMinimalHarness: true,
            splitMemory: { enabled: true, minSamplesForEnforcement: 2, maxEventsPerProfile: 64, minimumLeafScale: 0.25, maximumLeafScale: 1.5, anomalyPenalty: 0.35, successGrowth: 0.12, tokenSafetyFactor: 1.35 },
        },
        monitor: {
            enabled: true,
            host: "127.0.0.1",
            port: monitorPort,
            autoStart: true,
            charsPerEstimatedToken: 4,
            pricingAsOf: "mcp-acceptance",
            pricing: {},
            currency: { primary: "CNY", showUsd: false, usdToCnyRate: null, fxAsOf: "not-configured", fxSource: "manual" },
        },
        provider: { baseUrl: "https://invalid.example", apiKeyFile: providerKeyPath },
        harnessIsolation: {
            bubblewrapBinary: bwrap.realpath,
            bubblewrapSha256: bwrap.sha256,
            relayPort: 43_128,
            rejectEnvFiles: true,
            resourceProfile,
        },
        llamaCpp: {
            enabled: false,
            autoRouteSimpleLeaves: true,
            mode: "external_server",
            baseUrl: "http://127.0.0.1:18080/v1",
            apiKeyEnv: "LLAMA_CPP_API_KEY",
            model: "local-model",
            serverBinary: "llama-server",
            serverArgs: [],
            serverAutoStart: false,
            serverStartupTimeoutSeconds: 30,
            cliBinary: "llama-cli",
            cliArgs: ["--prompt-file", "{{PROMPT_FILE}}", "-n", "{{MAX_TOKENS}}", "--temp", "0"],
            requestTimeoutSeconds: 30,
            maxFilesPerTask: 3,
            maxContextFiles: 8,
            maxContextBytes: 512_000,
            maxFileBytes: 256_000,
            maxOutputTokens: 2_000,
            fallbackEnabled: true,
            fallbackModel: "deepseek-v4-flash",
        },
    }, null, 2)}\n`, { mode: 0o600 });
    const rendered = await runProcess("python3", [
        path.join(packageRoot, "scripts", "render-minimal-harness.py"), "install",
        "--template-root", path.join(packageRoot, "harness", "minimal"),
        "--profile-dir", path.join(dshHome, "profiles", minimalProfileName),
        "--preset-dir", path.join(dshHome, ".agent-presets", "codex-bridge-minimal"),
        "--runtime", packageRoot,
        "--config", configPath,
    ], { timeoutMs: 30_000, maxCaptureChars: 200_000 });
    assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
    const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const client = await StdioMcpClient.connect(process.execPath, [serverPath], {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? os.homedir(),
        CODEX_HARNESS_CONFIG: configPath,
    });
    try {
        const listed = await client.listTools();
        const toolNames = new Set((listed.tools ?? []).map((tool) => tool.name));
        for (const required of [
            "controller_plan_create", "controller_split_advice", "controller_split_memory", "controller_launch_leaf", "controller_review_task", "controller_finalize_plan",
            "harness_status", "harness_collect", "harness_read_changed_file", "harness_verify", "harness_commit",
            "harness_monitor_snapshot",
        ])
            assert.equal(toolNames.has(required), true, `missing MCP tool ${required}`);
        const doctor = await call(client, "bridge_doctor", { probeHarness: true });
        assert.equal(doctor.ok, true, JSON.stringify(doctor));
        assert.equal(doctor.controlledUseAllowed, false, "audit fixture must never claim controlled use");
        assert.equal(doctor.executionMode, "audit_only");
        const legacy = await expectToolError(client, "harness_start", {
            repoRoot: repo,
            objective: "legacy free-form task must be rejected",
            harnessWritePaths: ["src/harness/**"],
        });
        assert.match(String(legacy.error), /planId is required/);
        const flashLarge = await expectToolError(client, "controller_plan_create", {
            repoRoot: repo,
            planId: "mcp-flash-large-plan",
            leaves: [{
                    id: "flash-large", objective: "Flash must stay finely decomposed", executor: "harness", complexity: "large", model: "deepseek-v4-flash",
                    harnessWritePaths: ["src/pro/**"], acceptanceCriteria: ["rejected"], verificationCommands: ["true"],
                }],
        });
        assert.match(String(flashLarge.error), /deepseek-v4-pro/);
        const proPlan = await call(client, "controller_plan_create", {
            repoRoot: repo,
            planId: "mcp-pro-complex-plan",
            leaves: [{
                    id: "pro-complex", objective: "One complex Pro leaf", executor: "harness", complexity: "large", model: "deepseek-v4-pro",
                    harnessWritePaths: ["src/pro/**"], acceptanceCriteria: ["bounded complex implementation"], verificationCommands: ["true"],
                    budget: { maxApiCalls: 500, maxInputTokens: 20_000_000, maxOutputTokens: 2_000_000, maxCostCny: 1000, maxCostUsd: 150 },
                }],
        });
        const proLeaf = proPlan.leaves[0];
        assert.equal(proLeaf.complexity, "large");
        assert.equal(proLeaf.model, "deepseek-v4-pro");
        assert.equal(proLeaf.budget.enforcement, "hard");
        assert.equal(proLeaf.budget.gatePolicy, "input_output_tokens");
        assert.equal(proLeaf.budget.ceilingPolicy, "unbounded");
        assert.equal(proLeaf.harnessMode, "minimal");
        const splitAdvice = await call(client, "controller_split_advice", {
            repoRoot: repo,
            candidates: [{ id: "mcp-advice", taskFamily: "mcp-family", executor: "harness", harnessMode: "minimal", complexity: "small" }],
        });
        assert.equal(splitAdvice.adaptiveMemoryEnabled, true);
        assert.equal(splitAdvice.candidates.length, 1);
        const splitMemory = await call(client, "controller_split_memory", { repoRoot: repo });
        assert.equal(splitMemory.enabled, true);
        const plan = await call(client, "controller_plan_create", {
            repoRoot: repo,
            planId: "mcp-plan",
            leaves: [{
                    id: "implementation",
                    objective: "NO_MODEL_CALL",
                    executor: "harness",
                    complexity: "small",
                    harnessWritePaths: ["src/harness/**"],
                    codexWritePaths: ["tests/**"],
                    acceptanceCriteria: ["create result.txt"],
                    contextFiles: ["README.md"],
                    verificationCommands: ["test -f src/harness/result.txt"],
                }],
        });
        assert.equal(plan.planId, "mcp-plan");
        const start = await call(client, "controller_launch_leaf", { planId: "mcp-plan", leafId: "implementation", taskId: "mcp-task" });
        assert.equal(start.status, "queued");
        const terminal = await waitTerminal(client, "mcp-task");
        assert.equal(terminal.status, "completed", JSON.stringify(terminal));
        const collected = await call(client, "harness_collect", { taskId: "mcp-task", includePatch: true, maxPatchChars: 100_000 });
        const changed = collected.changedPaths;
        assert.deepEqual(changed, ["src/harness/result.txt"]);
        const read = await call(client, "harness_read_changed_file", { taskId: "mcp-task", filePath: changed[0] });
        assert.match(String(read.content), /implemented/);
        await expectToolError(client, "harness_verify", { taskId: "mcp-task" });
        const review = await call(client, "controller_review_task", {
            taskId: "mcp-task",
            decision: "approved",
            reviewedPaths: changed,
            notes: "Reviewed through MCP acceptance.",
        });
        assert.match(String(review.reviewedFingerprint), /^[0-9a-f]{64}$/);
        const verified = await call(client, "harness_verify", { taskId: "mcp-task" });
        assert.equal(verified.passed, true, JSON.stringify(verified));
        const committed = await call(client, "harness_commit", { taskId: "mcp-task", message: "test: MCP accepted leaf" });
        assert.match(String(committed.commit), /^[0-9a-f]{40,64}$/);
        const finalized = await call(client, "controller_finalize_plan", {
            planId: "mcp-plan",
            integrationEvidence: "MCP client reviewed every path and frozen verification passed.",
        });
        assert.equal(finalized.status, "accepted");
        const cleanup = await call(client, "harness_cleanup", { taskId: "mcp-task", force: true, deleteBranch: true });
        assert.equal(cleanup.worktreeRemoved, true);
        assert.equal(cleanup.branchDeleted, true);
        process.stdout.write(`${JSON.stringify({
            result: "PASS",
            transport: "stdio-jsonrpc",
            serverVersion: "0.6.6",
            toolCount: toolNames.size,
            planId: plan.planId,
            proPlanId: proPlan.planId,
            proComplexBudgetEnforcement: proLeaf.budget.enforcement,
            proComplexTokenGatePolicy: proLeaf.budget.gatePolicy,
            adaptiveSplitTools: true,
            taskId: "mcp-task",
            commit: committed.commit,
        }, null, 2)}\n`);
    }
    finally {
        try {
            await call(client, "harness_monitor_stop", {});
        }
        catch { /* fixture cleanup remains best effort */ }
        await client.close();
    }
}
finally {
    if (process.env.KEEP_CODEX_HARNESS_ACCEPTANCE !== "1")
        await rm(temp, { recursive: true, force: true });
}
//# sourceMappingURL=acceptance-client.js.map