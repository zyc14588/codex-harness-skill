import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTask, collectTask, commitTask, createControllerPlan, controllerSplitAdvice, controllerSplitMemory, doctor, finalizeControllerPlan, monitorSnapshot, monitorStatus, monitorStop, readChangedFile, repairTask, reviewTask, startTask, taskStatus, verifyTask, } from "./service.js";
import { runProcess, sleep } from "./util.js";
function acceptanceTrace(message) {
    if (process.env.CODEX_HARNESS_ACCEPTANCE_TRACE === "1")
        process.stderr.write(`[acceptance trace] ${message}\n`);
}
function payload(value) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `expected object, got ${JSON.stringify(value)}`);
    return value;
}
function payloadArray(value) {
    assert.ok(Array.isArray(value), `expected array, got ${JSON.stringify(value)}`);
    return value.map(payload);
}
async function expectFailure(action, pattern) {
    await assert.rejects(action, pattern);
}
async function git(repo, args) {
    const result = await runProcess("git", args, { cwd: repo, timeoutMs: 20_000, maxCaptureChars: 200_000 });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}
async function waitTerminal(taskId, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = payload(await taskStatus(taskId));
        if (!["queued", "running"].includes(String(status.status)))
            return status;
        await sleep(75);
    }
    throw new Error(`task did not reach a terminal state: ${taskId}`);
}
async function waitProcessesStopped(taskId, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = payload(await taskStatus(taskId));
        if (status.workerAlive !== true && status.harnessAlive !== true)
            return status;
        await sleep(100);
    }
    throw new Error(`task processes did not stop: ${taskId}`);
}
async function readBody(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
function json(response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
    response.end(body);
}
async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return address.port;
}
async function reserveLoopbackPort(excluded = new Set()) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const server = http.createServer((_request, response) => response.end());
        const port = await listen(server);
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        if (!excluded.has(port))
            return port;
    }
    throw new Error("could not reserve a distinct loopback port");
}
async function closeServer(server, timeoutMs = 2_000) {
    if (!server.listening)
        return;
    // Stop accepting first, then terminate current keep-alive/active sockets. The
    // reverse order leaves a small race where a new connection can arrive after
    // closeAllConnections() and keep server.close() pending indefinitely.
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await Promise.race([closed, sleep(timeoutMs)]);
    server.closeAllConnections?.();
}
async function approveVerifyCommit(taskId, message) {
    // A terminal task record can be published a few milliseconds before the detached
    // worker and its Harness child fully release pipes and repository-scoped locks.
    // Wait for process quiescence before collecting/reviewing so deterministic
    // acceptance cannot race worker teardown under concurrent minimal leaves.
    await waitProcessesStopped(taskId);
    const collected = payload(await collectTask(taskId, true, 100_000));
    const changed = collected.changedPaths;
    assert.ok(Array.isArray(changed) && changed.length > 0);
    for (const file of changed) {
        const read = payload(await readChangedFile(taskId, file));
        assert.equal(read.filePath, file);
    }
    const review = payload(await reviewTask(taskId, "approved", changed, "Codex reviewed every changed file in deterministic acceptance."));
    assert.match(String(review.reviewedFingerprint), /^[0-9a-f]{64}$/);
    const verification = payload(await verifyTask(taskId, undefined, 30));
    assert.equal(verification.passed, true, JSON.stringify(verification));
    assert.equal(verification.reviewedFingerprint, verification.verifiedFingerprint);
    const committed = payload(await commitTask(taskId, message));
    assert.match(String(committed.commit), /^[0-9a-f]{40,64}$/);
    return committed;
}
async function dashboardMutation(baseUrl, csrf, endpoint, method, body) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: {
            "content-type": "application/json",
            "x-codex-harness-csrf": csrf,
            origin: baseUrl,
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return payload(JSON.parse(text));
}
function outputPathsFromPrompt(prompt) {
    const match = /^Required output paths: (.+)$/m.exec(prompt);
    if (!match?.[1])
        return [];
    const value = JSON.parse(match[1]);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
const temp = await mkdtemp(path.join(os.tmpdir(), "codex-harness-m1-r6-4-acceptance-"));
const repo = path.join(temp, "repo");
const stateRoot = path.join(temp, "state");
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const dshHome = path.join(temp, "dsh-home");
const renderMinimalHarness = path.join(packageRoot, "scripts", "render-minimal-harness.py");
const minimalProfileName = "codex-minimal-headless";
const fakeDsh = fileURLToPath(new URL("../../scripts/fake-dsh.mjs", import.meta.url));
const fakeLlamaCli = path.join(temp, "fake-llama-cli.mjs");
const fakeManagedServer = path.join(temp, "fake-managed-llama-server.mjs");
const monitorPort = await reserveLoopbackPort();
const managedLlamaPort = await reserveLoopbackPort(new Set([monitorPort]));
let providerCalls = 0;
const providerModels = [];
let llamaCalls = 0;
const providerServer = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/chat/completions")) {
        providerCalls += 1;
        const raw = await readBody(request);
        const body = JSON.parse(raw || "{}");
        assert.ok(body.model === "deepseek-v4-flash" || body.model === "deepseek-v4-pro", `unexpected provider model: ${body.model}`);
        providerModels.push(body.model);
        const requestText = JSON.stringify(body.messages ?? []);
        if (requestText.includes("Create a concise title for an AI coding-assistant session")) {
            assert.equal(body.tools, undefined, "auxiliary title request must not advertise mutation tools");
            assert.equal(body.tool_choice, undefined, "auxiliary title request must not be forced into tool_choice");
            assert.deepEqual(body.thinking, { type: "disabled" });
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: "R6.4 smoke" }, finish_reason: "stop" }], usage: { prompt_tokens: 1055, completion_tokens: 7, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 255 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("DSML_MALFORMED_PROBE")) {
            assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "malformed DSML probe must advertise native tools");
            const malformed = `<｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">touch forbidden`;
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: malformed }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 18, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 70 } })}

`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("REQUIRED_TOOL_CHOICE_VIOLATION_PROBE")) {
            assert.equal(body.tool_choice, "required", "diff-free minimal Flash request must require a tool call");
            assert.deepEqual(body.thinking, { type: "disabled" });
            assert.equal(body.reasoning_effort, undefined);
            const names = (body.tools ?? []).map((tool) => tool.function?.name).filter((name) => typeof name === "string");
            assert.deepEqual(names, ["bash"]);
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: "I will create the requested file now." }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 12, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100 } })}

`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("TEXTUAL_TOOL_CALL_RECOVERY_PROBE")) {
            assert.equal(body.tool_choice, "required", "minimal Flash mutation request must force a tool call before any diff exists");
            assert.deepEqual(body.thinking, { type: "disabled" }, "forced mutation request must disable thinking before using tool_choice");
            assert.equal(body.reasoning_effort, undefined);
            const names = (body.tools ?? []).map((tool) => tool.function?.name).filter((name) => typeof name === "string");
            assert.deepEqual(names, ["bash"], "forced request must expose only the disclosed core mutation tool in this fixture");
            const command = `mkdir -p src/harness && printf '{"status":"textual-normalized"}\n' > src/harness/textual-tool-call.json`;
            const textual = `bash tool-call:\n${JSON.stringify({ command })}`;
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: textual }, finish_reason: "stop" }], usage: { prompt_tokens: 180, completion_tokens: 58, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 140 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("TITLE_AUXILIARY_BEFORE_MUTATION_PROBE")) {
            assert.equal(body.tool_choice, "required", "primary diff-free mutation request must be forced after title bypass");
            assert.deepEqual(body.thinking, { type: "disabled" });
            const names = (body.tools ?? []).map((tool) => tool.function?.name).filter((name) => typeof name === "string");
            assert.ok(names.includes("bash"), `primary request must disclose bash: ${JSON.stringify(names)}`);
            const command = `mkdir -p src/harness && printf '{"status":"title-auxiliary-isolated"}\n' > src/harness/title-auxiliary-isolated.json`;
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-title-auxiliary-primary", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 145, completion_tokens: 39, prompt_cache_hit_tokens: 35, prompt_cache_miss_tokens: 110 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("NATIVE_TOOL_CALL_PROBE")) {
            assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "native tool-call probe must advertise native tools");
            const command = `mkdir -p src/harness && printf '{"status":"native"}\n' > src/harness/native-tool-call.json`;
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-provider-native", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 140, completion_tokens: 44, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 100 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("MARKDOWN_SHELL_RECOVERY_PROBE")) {
            assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "Markdown shell recovery probe must advertise native tools");
            assert.match(requestText, /CODEX-HARNESS BOUNDED LEAF CONTRACT/, "Markdown recovery must be limited to a bounded leaf request");
            const markdown = "```bash\nmkdir -p src/harness && printf '{\"status\":\"markdown-recovered\"}\\n' > src/harness/markdown-recovered.json\n```";
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const first = markdown.slice(0, 11);
            const second = markdown.slice(11);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: first }, finish_reason: null }] })}\n\n`);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: second }, finish_reason: "stop" }], usage: { prompt_tokens: 1030, completion_tokens: 516, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 230 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (requestText.includes("DSML_RECOVERY_PROBE")) {
            assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "DSML recovery probe must advertise native tools");
            const command = `mkdir -p src/harness && printf '{"status":"recovered"}\n' > src/harness/dsml-recovered.json`;
            const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">${command}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const first = dsml.slice(0, 17);
            const second = dsml.slice(17);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: first }, finish_reason: null }] })}\n\n`);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, model: body.model, choices: [{ index: 0, delta: { content: second }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 32, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        if (body.stream === true) {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, choices: [{ index: 0, delta: { content: "bounded " } }] })}\n\n`);
            await sleep(650);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, choices: [{ index: 0, delta: { content: "streaming guidance" } }] })}\n\n`);
            await sleep(650);
            response.write(`data: ${JSON.stringify({ id: `provider-${providerCalls}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 25, prompt_cache_miss_tokens: 75 } })}\n\n`);
            response.write("data: [DONE]\n\n");
            return response.end();
        }
        return json(response, 200, {
            id: `provider-${providerCalls}`,
            choices: [{ index: 0, message: { role: "assistant", content: "bounded implementation guidance" }, finish_reason: "stop" }],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 12,
                prompt_cache_hit_tokens: 25,
                prompt_cache_miss_tokens: 75,
            },
        });
    }
    return json(response, 404, { error: "not found" });
});
const providerPort = await listen(providerServer);
const llamaServer = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health")
        return json(response, 200, { status: "ok" });
    if (url.pathname === "/v1/models")
        return json(response, 200, { data: [{ id: "acceptance-local-model", object: "model" }] });
    if (url.pathname === "/v1/chat/completions") {
        llamaCalls += 1;
        const body = JSON.parse(await readBody(request));
        const prompt = body.messages?.[0]?.content ?? "";
        if (prompt.includes("LLAMA_FORCE_TIMEOUT"))
            await sleep(2_500);
        if (prompt.includes("LLAMA_FORCE_ERROR"))
            return json(response, 503, { error: "intentional local model failure" });
        const expected = outputPathsFromPrompt(prompt);
        const files = prompt.includes("LLAMA_OMIT_OUTPUT")
            ? []
            : expected.map((file) => ({ path: file, content: "generated by local llama.cpp acceptance server\n" }));
        return json(response, 200, {
            id: `llama-${llamaCalls}`,
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ files, summary: "local leaf generated" }) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 80, completion_tokens: 20 },
        });
    }
    return json(response, 404, { error: "not found" });
});
const llamaPort = await listen(llamaServer);
try {
    await writeFile(fakeLlamaCli, `import { readFile, writeFile } from "node:fs/promises";\nconst args=process.argv.slice(2);\nconst get=(flag)=>{const i=args.indexOf(flag);if(i<0||!args[i+1])throw new Error("missing "+flag);return args[i+1]};\nconst prompt=await readFile(get("--prompt-file"),"utf8");\nconst match=/^Required output paths: (.+)$/m.exec(prompt);\nconst paths=match?JSON.parse(match[1]):[];\nconst files=paths.map((file)=>({path:file,content:"generated by custom llama-cli acceptance adapter\\n"}));\nawait writeFile(get("--output"),JSON.stringify({files,summary:"custom cli complete"}),"utf8");\n`, "utf8");
    await writeFile(fakeManagedServer, `import http from "node:http";\nconst port=${managedLlamaPort};\nconst server=http.createServer(async(req,res)=>{const url=new URL(req.url||"/","http://127.0.0.1");let data;if(url.pathname==="/health")data={status:"ok"};else if(url.pathname==="/v1/models")data={data:[{id:"managed-acceptance-model",object:"model"}]};else if(url.pathname==="/v1/chat/completions")data={choices:[{message:{content:JSON.stringify({files:[],summary:"unused"})}}],usage:{prompt_tokens:1,completion_tokens:1}};else{res.statusCode=404;data={error:"not found"}}const body=Buffer.from(JSON.stringify(data));res.setHeader("content-type","application/json");res.setHeader("content-length",body.length);res.end(body)});\nserver.listen(port,"127.0.0.1");\nconst stop=()=>server.close(()=>process.exit(0));process.on("SIGTERM",stop);process.on("SIGINT",stop);\n`, "utf8");
    await mkdir(path.join(repo, "src/harness"), { recursive: true });
    await mkdir(path.join(repo, "src/slow"), { recursive: true });
    await mkdir(path.join(repo, "src/second"), { recursive: true });
    await mkdir(path.join(repo, "src/local"), { recursive: true });
    await mkdir(path.join(repo, "src/pro"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "controller acceptance context\n");
    for (const target of ["src/harness/.gitkeep", "src/slow/.gitkeep", "src/second/.gitkeep", "src/local/.gitkeep", "src/pro/.gitkeep", "tests/.gitkeep"]) {
        await writeFile(path.join(repo, target), "");
    }
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "acceptance@example.invalid"]);
    await git(repo, ["config", "user.name", "Bridge Acceptance"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "fixture"]);
    const configPath = path.join(temp, "config.json");
    await writeFile(configPath, `${JSON.stringify({
        schemaVersion: 6,
        harnessRoot: path.dirname(fakeDsh),
        harnessCli: fakeDsh,
        harnessProfile: "headless",
        harnessMinimalProfile: minimalProfileName,
        dshHome,
        stateRoot,
        allowedRepoRoots: [temp],
        passEnvironment: ["PATH", "HOME", "USER", "LANG", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DSH_MODEL", "LLAMA_CPP_API_KEY"],
        defaultRuntimeSeconds: 60,
        maxRuntimeSeconds: 300,
        logTailChars: 20_000,
        enforceHarnessPin: false,
        enforceHarnessBuildHash: false,
        requireCleanRepoAtStart: true,
        allowDirtyHarnessCheckout: false,
        controller: {
            requirePlan: true,
            maxLeavesPerPlan: 24,
            maxHarnessWriteLeases: 12,
            maxHarnessContextFiles: 12,
            maxHarnessAcceptanceCriteria: 12,
            maxHarnessObjectiveChars: 6_000,
            defaultHarnessBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "operator_bounded", enforcement: "hard", maxApiCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2.5, maxCostUsd: 0.35 },
            maximumHarnessBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "operator_bounded", enforcement: "hard", maxApiCalls: 10, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostCny: 10, maxCostUsd: 1 },
            defaultProComplexBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "unbounded", enforcement: "hard", maxApiCalls: 120, maxInputTokens: 4_000_000, maxOutputTokens: 512_000, maxCostCny: 360, maxCostUsd: 50 },
            maxConcurrentHarnessGlobal: 4,
            maxConcurrentHarnessPerRepo: 3,
            preferMinimalHarness: true,
            splitMemory: { enabled: true, minSamplesForEnforcement: 1, maxEventsPerProfile: 64, minimumLeafScale: 0.25, maximumLeafScale: 1.5, anomalyPenalty: 0.35, successGrowth: 0.12, tokenSafetyFactor: 1.35 },
        },
        monitor: {
            enabled: true,
            host: "127.0.0.1",
            port: monitorPort,
            autoStart: true,
            charsPerEstimatedToken: 4,
            pricingAsOf: "2026-08-19 DeepSeek official CNY reference; local estimate only",
            pricing: {
                "deepseek-v4-flash": {
                    inputCacheHitCnyPerMillion: 0.02,
                    inputCacheMissCnyPerMillion: 1,
                    outputCnyPerMillion: 2,
                    inputCacheHitUsdPerMillion: 0.0028,
                    inputCacheMissUsdPerMillion: 0.14,
                    outputUsdPerMillion: 0.28,
                },
            },
            currency: { primary: "CNY", showUsd: false, usdToCnyRate: null, fxAsOf: "not-configured", fxSource: "manual compatibility only" },
        },
        llamaCpp: {
            enabled: true,
            autoRouteSimpleLeaves: true,
            mode: "external_server",
            baseUrl: `http://127.0.0.1:${llamaPort}/v1`,
            apiKeyEnv: "LLAMA_CPP_API_KEY",
            model: "acceptance-local-model",
            serverBinary: "llama-server",
            serverArgs: [],
            serverAutoStart: false,
            serverStartupTimeoutSeconds: 10,
            cliBinary: "llama-cli",
            cliArgs: ["-p", "{{PROMPT}}", "-n", "{{MAX_TOKENS}}"],
            requestTimeoutSeconds: 1,
            maxFilesPerTask: 3,
            maxContextFiles: 8,
            maxContextBytes: 512_000,
            maxFileBytes: 256_000,
            maxOutputTokens: 2_000,
            fallbackEnabled: true,
            fallbackModel: "deepseek-v4-flash",
        },
    }, null, 2)}\n`);
    const minimalRender = await runProcess("python3", [
        renderMinimalHarness, "install",
        "--template-root", path.join(packageRoot, "harness", "minimal"),
        "--profile-dir", path.join(dshHome, "profiles", minimalProfileName),
        "--preset-dir", path.join(dshHome, ".agent-presets", "codex-bridge-minimal"),
        "--runtime", packageRoot,
        "--config", configPath,
        "--node", process.execPath,
    ], { timeoutMs: 30_000, maxCaptureChars: 200_000 });
    assert.equal(minimalRender.code, 0, minimalRender.stderr || minimalRender.stdout);
    process.env.CODEX_HARNESS_CONFIG = configPath;
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${providerPort}`;
    process.env.DEEPSEEK_API_KEY = "acceptance-secret-not-persisted";
    const doctorResult = payload(await doctor(true));
    assert.equal(doctorResult.ok, true, JSON.stringify(doctorResult));
    const monitorHealth = payload(await monitorStatus());
    assert.equal(monitorHealth.ok, true, JSON.stringify(monitorHealth));
    const dashboardBase = `http://127.0.0.1:${monitorPort}`;
    const dashboard = await fetch(`${dashboardBase}/`);
    assert.equal(dashboard.status, 200);
    const dashboardText = await dashboard.text();
    for (const required of ["Codex ↔ Harness 控制中心", "任务", "费用", "本地模型", "当前执行任务", "自适应拆分记忆", "人工费用对账", "全局预算策略", "Pro 复杂叶子默认高 Token 门禁", "输入 Token 与输出 Token 是唯一执行门禁", "llama-cli", "llama-server", "CN¥"]) {
        assert.match(dashboardText, new RegExp(required));
    }
    assert.match(dashboardText, /data-theme="soft"/);
    assert.match(dashboardText, /color-scheme:light/);
    assert.doesNotMatch(dashboardText, /USD|美元/, "default dashboard must not display USD prices");
    const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(dashboardText)?.[1];
    assert.ok(inlineScript, "dashboard did not contain its inline controller script");
    const inlineScriptPath = path.join(temp, "dashboard-inline.js");
    await writeFile(inlineScriptPath, inlineScript, "utf8");
    const syntaxCheck = await runProcess(process.execPath, ["--check", inlineScriptPath], { timeoutMs: 10_000, maxCaptureChars: 100_000 });
    assert.equal(syntaxCheck.code, 0, syntaxCheck.stderr || syntaxCheck.stdout);
    const csrf = /const CSRF="([0-9a-f]{64})"/.exec(dashboardText)?.[1];
    assert.ok(csrf, "dashboard did not embed a CSRF token");
    const rejectedMutation = await fetch(`${dashboardBase}/api/budget-policy`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: dashboardBase },
        body: JSON.stringify({ reason: "must reject missing csrf" }),
    });
    assert.equal(rejectedMutation.status, 403);
    await createControllerPlan({
        repoRoot: repo,
        planId: "stream-plan",
        leaves: [{
                id: "stream", objective: "STREAM_MODEL_TASK", executor: "harness", complexity: "small",
                harnessWritePaths: ["src/harness/**"], acceptanceCriteria: ["exercise realtime monitor"], verificationCommands: ["true"],
                budget: { maxApiCalls: 2, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostCny: 0.5 },
            }],
    });
    await startTask({ planId: "stream-plan", leafId: "stream", taskId: "stream-task" });
    const liveDeadline = Date.now() + 8_000;
    let liveSnapshot;
    while (Date.now() < liveDeadline) {
        const candidate = payload(await monitorSnapshot(200));
        const row = payloadArray(candidate.tasks).find((item) => item.taskId === "stream-task");
        const live = row?.liveUsage ? payload(row.liveUsage) : undefined;
        if (row && Number(candidate.liveEstimatedCostCny) > 0 && Number(live?.outputTokens ?? 0) > 0) {
            liveSnapshot = candidate;
            break;
        }
        await sleep(100);
    }
    assert.ok(liveSnapshot, "monitor did not expose in-flight CNY token/cost accrual before provider completion");
    assert.ok(Number(liveSnapshot.liveEstimatedCostCny) > 0);
    assert.equal(liveSnapshot.liveEstimatedCostUsd, undefined);
    const streamTerminal = await waitTerminal("stream-task");
    assert.equal(streamTerminal.status, "completed", JSON.stringify(streamTerminal));
    await cleanupTask("stream-task", true, true);
    await expectFailure(() => createControllerPlan({
        repoRoot: repo,
        planId: "flash-large-plan",
        leaves: [{
                id: "flash-large", objective: "Flash must retain current decomposition granularity", executor: "harness", complexity: "large", model: "deepseek-v4-flash",
                harnessWritePaths: ["src/harness/**"], acceptanceCriteria: ["done"], verificationCommands: ["true"],
            }],
    }), /only Harness pinned to deepseek-v4-pro/i);
    const proComplexPlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "pro-complex-plan",
        leaves: [{
                id: "pro-complex", objective: "PRO_COMPLEX_TASK", executor: "harness", complexity: "large", model: "deepseek-v4-pro",
                harnessWritePaths: ["src/pro/**"], acceptanceCriteria: ["Create src/pro/complex.txt through one complex Pro leaf"],
                verificationCommands: ["grep -q 'deepseek-v4-pro complex leaf' src/pro/complex.txt"],
                budget: { maxApiCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostCny: 0.000000001, maxCostUsd: 0.000000001 },
            }],
    }));
    const proLeaf = payloadArray(proComplexPlan.leaves)[0];
    assert.equal(proLeaf.model, "deepseek-v4-pro");
    assert.equal(proLeaf.complexity, "large");
    assert.equal(payload(proLeaf.budget).enforcement, "hard");
    assert.equal(payload(proLeaf.budget).gatePolicy, "input_output_tokens");
    assert.equal(payload(proLeaf.budget).ceilingPolicy, "unbounded");
    assert.equal(proLeaf.harnessMode, "minimal");
    await startTask({ planId: "pro-complex-plan", leafId: "pro-complex", taskId: "pro-complex-task" });
    const proTerminal = await waitTerminal("pro-complex-task");
    assert.equal(proTerminal.status, "completed", JSON.stringify(proTerminal));
    assert.equal(payload(proTerminal.budget).enforcement, "hard");
    const proSnapshot = payload(await monitorSnapshot(200));
    const proRow = payloadArray(proSnapshot.tasks).find((item) => item.taskId === "pro-complex-task");
    assert.ok(proRow, "monitor did not expose Pro complex task");
    assert.equal(proRow.budgetEnforcement, "hard");
    assert.equal(proRow.budgetState, "within_token_gate");
    assert.ok(Array.isArray(proRow.referenceAlerts) && proRow.referenceAlerts.length > 0, JSON.stringify(proRow));
    await approveVerifyCommit("pro-complex-task", "test: accept Pro complex token-gated leaf");
    await finalizeControllerPlan("pro-complex-plan", "Codex reviewed and verified the complex Pro leaf.");
    await cleanupTask("pro-complex-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "reference-only-plan",
        leaves: [{
                id: "reference-only", objective: "REFERENCE_ONLY_TASK TARGET_PATH: src/harness/reference-only.txt", executor: "harness", complexity: "small",
                harnessWritePaths: ["src/harness/reference-only.txt"], acceptanceCriteria: ["API/cost reference thresholds do not stop execution"],
                verificationCommands: ["grep -q '^implemented$' src/harness/reference-only.txt"],
                budget: { maxApiCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostCny: 0.000000001, maxCostUsd: 0.000000001 },
            }],
    });
    await startTask({ planId: "reference-only-plan", leafId: "reference-only", taskId: "reference-only-task" });
    const referenceTerminal = await waitTerminal("reference-only-task");
    assert.equal(referenceTerminal.status, "completed", JSON.stringify(referenceTerminal));
    assert.equal(payload(referenceTerminal.usage).apiCalls, 2);
    assert.ok(Array.isArray(referenceTerminal.referenceAlerts) && referenceTerminal.referenceAlerts.length > 0, JSON.stringify(referenceTerminal));
    await approveVerifyCommit("reference-only-task", "test: accept reference-only threshold leaf");
    await finalizeControllerPlan("reference-only-plan", "Codex verified that calls and cost are reference-only.");
    await cleanupTask("reference-only-task", true, true);
    const plan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "harness-plan",
        leaves: [{
                id: "implementation",
                objective: "CREATE_ALLOWED_FILE",
                executor: "harness",
                complexity: "small",
                harnessWritePaths: ["src/harness/**"],
                codexWritePaths: ["tests/**"],
                acceptanceCriteria: ["Create src/harness/result.txt containing implemented"],
                contextFiles: ["README.md"],
                verificationCommands: ["test -f src/harness/result.txt && grep -q '^implemented$' src/harness/result.txt"],
                budget: { maxApiCalls: 3, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostCny: 0.5 },
            }],
    }));
    assert.equal(plan.planId, "harness-plan");
    const started = payload(await startTask({ planId: "harness-plan", leafId: "implementation", taskId: "harness-task" }));
    assert.equal(started.status, "queued");
    await writeFile(path.join(repo, "tests/codex.txt"), "concurrent Codex lane\n");
    const terminal = await waitTerminal("harness-task");
    assert.equal(terminal.status, "completed", JSON.stringify(terminal));
    const usage = payload(terminal.usage);
    assert.equal(usage.apiCalls, 1);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 12);
    assert.ok(Number(usage.costCny) > 0);
    const harnessCommit = await approveVerifyCommit("harness-task", "test: accept Harness leaf");
    const finalized = payload(await finalizeControllerPlan("harness-plan", "Codex reviewed all files; frozen verification passed; commit recorded."));
    assert.equal(finalized.status, "accepted");
    await cleanupTask("harness-task", true, true);
    await git(repo, ["add", "tests/codex.txt"]);
    await git(repo, ["commit", "-m", "test: concurrent Codex lane"]);
    await createControllerPlan({
        repoRoot: repo,
        planId: "dsml-recovery-plan",
        leaves: [{
                id: "dsml-recovery",
                objective: "DSML_RECOVERY_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                harnessWritePaths: ["src/harness/dsml-recovered.json"],
                acceptanceCriteria: ["Raw DeepSeek V4 DSML is recovered into an executable native bash tool call"],
                verificationCommands: [`test "$(cat src/harness/dsml-recovered.json)" = '{"status":"recovered"}'`],
                budget: { maxApiCalls: 3, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostCny: 1 },
            }],
    });
    await startTask({ planId: "dsml-recovery-plan", leafId: "dsml-recovery", taskId: "dsml-recovery-task" });
    const dsmlTerminal = await waitTerminal("dsml-recovery-task");
    assert.equal(dsmlTerminal.status, "completed", JSON.stringify(dsmlTerminal));
    assert.equal(dsmlTerminal.toolProtocolRecoveryCount, 1, JSON.stringify(dsmlTerminal));
    assert.ok(Array.isArray(dsmlTerminal.toolProtocolRecoveryKinds)
        && dsmlTerminal.toolProtocolRecoveryKinds.includes("dsml_content_to_tool_calls"), JSON.stringify(dsmlTerminal));
    assert.equal(dsmlTerminal.infrastructureFailureKind, undefined);
    await approveVerifyCommit("dsml-recovery-task", "test: accept recovered DSML tool call");
    await finalizeControllerPlan("dsml-recovery-plan", "Codex verified that raw DSML became an executed native tool call.");
    await cleanupTask("dsml-recovery-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "markdown-recovery-plan",
        leaves: [{
                id: "markdown-recovery",
                objective: "MARKDOWN_SHELL_RECOVERY_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "markdown-shell-recovery-family",
                harnessWritePaths: ["src/harness/markdown-recovered.json"],
                acceptanceCriteria: ["A standalone Markdown bash block is recovered and executed as a native bash tool call"],
                verificationCommands: [`test "$(cat src/harness/markdown-recovered.json)" = '{"status":"markdown-recovered"}'`],
                budget: { maxApiCalls: 3, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2 },
            }],
    });
    await startTask({ planId: "markdown-recovery-plan", leafId: "markdown-recovery", taskId: "markdown-recovery-task" });
    const markdownTerminal = await waitTerminal("markdown-recovery-task");
    assert.equal(markdownTerminal.status, "completed", JSON.stringify(markdownTerminal));
    assert.equal(markdownTerminal.toolProtocolRecoveryCount, 1, JSON.stringify(markdownTerminal));
    assert.ok(Array.isArray(markdownTerminal.toolProtocolRecoveryKinds)
        && markdownTerminal.toolProtocolRecoveryKinds.includes("markdown_shell_fence_to_tool_calls"), JSON.stringify(markdownTerminal));
    assert.ok(Array.isArray(markdownTerminal.toolProtocolRecoveredTools)
        && markdownTerminal.toolProtocolRecoveredTools.includes("bash"), JSON.stringify(markdownTerminal));
    assert.equal(markdownTerminal.infrastructureFailureKind, undefined, JSON.stringify(markdownTerminal));
    const markdownCollect = payload(await collectTask("markdown-recovery-task", true, 100_000));
    assert.deepEqual(markdownCollect.changedPaths, ["src/harness/markdown-recovered.json"]);
    await approveVerifyCommit("markdown-recovery-task", "test: accept recovered Markdown shell tool call");
    await finalizeControllerPlan("markdown-recovery-plan", "Codex verified that standalone Markdown shell output became an executed native tool call.");
    await cleanupTask("markdown-recovery-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "textual-tool-call-plan",
        leaves: [{
                id: "textual-tool-call",
                objective: "TEXTUAL_TOOL_CALL_RECOVERY_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "textual-tool-call-recovery-family",
                harnessWritePaths: ["src/harness/textual-tool-call.json"],
                acceptanceCriteria: ["Textual bash tool-call envelope is normalized and writes the exact leased file"],
                verificationCommands: ["test -f src/harness/textual-tool-call.json && grep -q textual-normalized src/harness/textual-tool-call.json"],
                budget: { maxApiCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2 },
            }],
    });
    await startTask({ planId: "textual-tool-call-plan", leafId: "textual-tool-call", taskId: "textual-tool-call-task" });
    const textualTerminal = await waitTerminal("textual-tool-call-task");
    assert.equal(textualTerminal.status, "completed", JSON.stringify(textualTerminal));
    assert.equal(textualTerminal.toolProtocolRecoveryCount, 1, JSON.stringify(textualTerminal));
    assert.ok(Array.isArray(textualTerminal.toolProtocolRecoveryKinds)
        && textualTerminal.toolProtocolRecoveryKinds.includes("text_tool_call_envelope_to_tool_calls"), JSON.stringify(textualTerminal));
    assert.equal(textualTerminal.minimalMutationForceCount, 1, JSON.stringify(textualTerminal));
    assert.equal(textualTerminal.minimalMutationPolicyVersion, "minimal-flash-required-v2", JSON.stringify(textualTerminal));
    assert.ok(Array.isArray(textualTerminal.minimalMutationForcedTools)
        && textualTerminal.minimalMutationForcedTools.includes("bash"), JSON.stringify(textualTerminal));
    assert.equal(textualTerminal.infrastructureFailureKind, undefined, JSON.stringify(textualTerminal));
    const textualCollect = payload(await collectTask("textual-tool-call-task", true, 100_000));
    assert.deepEqual(textualCollect.changedPaths, ["src/harness/textual-tool-call.json"]);
    await approveVerifyCommit("textual-tool-call-task", "test: accept forced minimal textual tool call");
    await finalizeControllerPlan("textual-tool-call-plan", "Codex verified forced non-thinking tool choice, textual normalization, and repository effect.");
    await cleanupTask("textual-tool-call-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "native-tool-call-plan",
        leaves: [{
                id: "native-tool-call",
                objective: "NATIVE_TOOL_CALL_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "native-structured-tool-family",
                harnessWritePaths: ["src/harness/native-tool-call.json"],
                acceptanceCriteria: ["Provider native structured tool call is observed and executed without recovery"],
                verificationCommands: [`test "$(cat src/harness/native-tool-call.json)" = '{"status":"native"}'`],
                budget: { maxApiCalls: 3, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2 },
            }],
    });
    await startTask({ planId: "native-tool-call-plan", leafId: "native-tool-call", taskId: "native-tool-call-task" });
    const nativeTerminal = await waitTerminal("native-tool-call-task");
    assert.equal(nativeTerminal.status, "completed", JSON.stringify(nativeTerminal));
    assert.equal(nativeTerminal.toolProtocolRecoveryCount, 0, JSON.stringify(nativeTerminal));
    assert.equal(nativeTerminal.toolProtocolNativeCallCount, 1, JSON.stringify(nativeTerminal));
    assert.ok(Array.isArray(nativeTerminal.toolProtocolNativeTools)
        && nativeTerminal.toolProtocolNativeTools.includes("bash"), JSON.stringify(nativeTerminal));
    assert.equal(nativeTerminal.infrastructureFailureKind, undefined, JSON.stringify(nativeTerminal));
    const nativeCollect = payload(await collectTask("native-tool-call-task", true, 100_000));
    assert.deepEqual(nativeCollect.changedPaths, ["src/harness/native-tool-call.json"]);
    await approveVerifyCommit("native-tool-call-task", "test: accept provider native structured tool call");
    await finalizeControllerPlan("native-tool-call-plan", "Codex verified provider-native structured tool evidence and repository effect.");
    await cleanupTask("native-tool-call-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "title-auxiliary-isolation-plan",
        leaves: [{
                id: "title-auxiliary-isolation",
                objective: "TITLE_AUXILIARY_BEFORE_MUTATION_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "title-auxiliary-isolation-family",
                harnessWritePaths: ["src/harness/title-auxiliary-isolated.json"],
                acceptanceCriteria: ["Tool-less title request is bypassed and the following primary mutation request is forced"],
                verificationCommands: [`test "$(cat src/harness/title-auxiliary-isolated.json)" = '{"status":"title-auxiliary-isolated"}'`],
                budget: { maxApiCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2 },
            }],
    });
    await startTask({ planId: "title-auxiliary-isolation-plan", leafId: "title-auxiliary-isolation", taskId: "title-auxiliary-isolation-task" });
    const titleIsolationTerminal = await waitTerminal("title-auxiliary-isolation-task");
    assert.equal(titleIsolationTerminal.status, "completed", JSON.stringify(titleIsolationTerminal));
    assert.equal(titleIsolationTerminal.minimalMutationAuxiliaryBypassCount, 1, JSON.stringify(titleIsolationTerminal));
    assert.ok(Array.isArray(titleIsolationTerminal.minimalMutationAuxiliaryBypassKinds)
        && titleIsolationTerminal.minimalMutationAuxiliaryBypassKinds.includes("session_title_auxiliary"), JSON.stringify(titleIsolationTerminal));
    assert.equal(titleIsolationTerminal.minimalMutationForceCount, 1, JSON.stringify(titleIsolationTerminal));
    assert.equal(titleIsolationTerminal.minimalMutationPolicyVersion, "minimal-flash-required-v2", JSON.stringify(titleIsolationTerminal));
    assert.equal(titleIsolationTerminal.toolProtocolNativeCallCount, 1, JSON.stringify(titleIsolationTerminal));
    assert.ok(Array.isArray(titleIsolationTerminal.toolProtocolNativeTools)
        && titleIsolationTerminal.toolProtocolNativeTools.includes("bash"), JSON.stringify(titleIsolationTerminal));
    assert.equal(titleIsolationTerminal.infrastructureFailureKind, undefined, JSON.stringify(titleIsolationTerminal));
    const titleIsolationCollect = payload(await collectTask("title-auxiliary-isolation-task", true, 100_000));
    assert.deepEqual(titleIsolationCollect.changedPaths, ["src/harness/title-auxiliary-isolated.json"]);
    await approveVerifyCommit("title-auxiliary-isolation-task", "test: isolate title request before forced primary mutation");
    await finalizeControllerPlan("title-auxiliary-isolation-plan", "Codex verified auxiliary title isolation, forced primary mutation, native tool execution, and repository effect.");
    await cleanupTask("title-auxiliary-isolation-task", true, true);
    const noEffectBefore = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "no-effect-before", taskFamily: "required-change-no-effect-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(noEffectBefore.sampleCount, 0);
    assert.equal(noEffectBefore.recommendedLeafScale, 1);
    await createControllerPlan({
        repoRoot: repo,
        planId: "no-effect-plan",
        leaves: [{
                id: "no-effect",
                objective: "COMPLETED_NO_CHANGES_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "required-change-no-effect-family",
                harnessWritePaths: ["src/harness/no-effect-must-exist.json"],
                acceptanceCriteria: ["Required leased output must exist; an empty diff is an infrastructure failure"],
                verificationCommands: ["test -f src/harness/no-effect-must-exist.json"],
                budget: { maxApiCalls: 3, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxCostCny: 2 },
            }],
    });
    await startTask({ planId: "no-effect-plan", leafId: "no-effect", taskId: "no-effect-task" });
    const noEffectTerminal = await waitTerminal("no-effect-task");
    assert.equal(noEffectTerminal.status, "failed", JSON.stringify(noEffectTerminal));
    assert.equal(noEffectTerminal.infrastructureFailureKind, "no_effect", JSON.stringify(noEffectTerminal));
    assert.deepEqual(noEffectTerminal.changedPaths, []);
    const noEffectCollect = payload(await collectTask("no-effect-task", true, 100_000));
    assert.deepEqual(noEffectCollect.changedPaths, []);
    await cleanupTask("no-effect-task", true, true);
    const noEffectAfter = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "no-effect-after", taskFamily: "required-change-no-effect-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(noEffectAfter.sampleCount, 0, JSON.stringify(noEffectAfter));
    assert.equal(noEffectAfter.recommendedLeafScale, 1, JSON.stringify(noEffectAfter));
    assert.equal(noEffectAfter.recommendedMaxInputTokens, noEffectBefore.recommendedMaxInputTokens, JSON.stringify(noEffectAfter));
    assert.equal(noEffectAfter.recommendedMaxOutputTokens, noEffectBefore.recommendedMaxOutputTokens, JSON.stringify(noEffectAfter));
    const noEffectMemory = payload(await controllerSplitMemory(repo));
    const noEffectProfile = payloadArray(noEffectMemory.profiles).find((item) => item.taskFamily === "required-change-no-effect-family");
    assert.ok(noEffectProfile, JSON.stringify(noEffectMemory));
    assert.equal(noEffectProfile.sampleCount, 0);
    assert.equal(noEffectProfile.successCount, 0);
    assert.equal(noEffectProfile.infrastructureFailureCount, 1);
    const requiredViolationBefore = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "required-violation-before", taskFamily: "required-tool-choice-violation-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(requiredViolationBefore.sampleCount, 0);
    await createControllerPlan({
        repoRoot: repo,
        planId: "required-tool-choice-violation-plan",
        leaves: [{
                id: "required-tool-choice-violation",
                objective: "REQUIRED_TOOL_CHOICE_VIOLATION_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "required-tool-choice-violation-family",
                harnessWritePaths: ["src/harness/required-tool-choice-must-not-exist.json"],
                acceptanceCriteria: ["A provider response that violates tool_choice=required must fail closed"],
                verificationCommands: ["test ! -e src/harness/required-tool-choice-must-not-exist.json"],
                budget: { maxApiCalls: 3, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostCny: 1 },
            }],
    });
    await startTask({ planId: "required-tool-choice-violation-plan", leafId: "required-tool-choice-violation", taskId: "required-tool-choice-violation-task" });
    const requiredViolationTerminal = await waitTerminal("required-tool-choice-violation-task");
    assert.equal(requiredViolationTerminal.status, "failed", JSON.stringify(requiredViolationTerminal));
    assert.equal(requiredViolationTerminal.infrastructureFailureKind, "tool_protocol", JSON.stringify(requiredViolationTerminal));
    assert.match(String(requiredViolationTerminal.toolProtocolFailure), /tool_choice=required returned no structured or safely recoverable tool call/u);
    assert.equal(requiredViolationTerminal.minimalMutationForceCount, 1, JSON.stringify(requiredViolationTerminal));
    assert.equal(requiredViolationTerminal.minimalMutationPolicyVersion, "minimal-flash-required-v2", JSON.stringify(requiredViolationTerminal));
    assert.deepEqual(requiredViolationTerminal.changedPaths, []);
    await cleanupTask("required-tool-choice-violation-task", true, true);
    const requiredViolationAfter = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "required-violation-after", taskFamily: "required-tool-choice-violation-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(requiredViolationAfter.sampleCount, 0, JSON.stringify(requiredViolationAfter));
    assert.equal(requiredViolationAfter.recommendedLeafScale, 1, JSON.stringify(requiredViolationAfter));
    assert.equal(requiredViolationAfter.recommendedMaxInputTokens, requiredViolationBefore.recommendedMaxInputTokens, JSON.stringify(requiredViolationAfter));
    assert.equal(requiredViolationAfter.recommendedMaxOutputTokens, requiredViolationBefore.recommendedMaxOutputTokens, JSON.stringify(requiredViolationAfter));
    const infrastructureBefore = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "infra-before", taskFamily: "dsml-infrastructure-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(infrastructureBefore.sampleCount, 0);
    assert.equal(infrastructureBefore.recommendedLeafScale, 1);
    await createControllerPlan({
        repoRoot: repo,
        planId: "dsml-malformed-plan",
        leaves: [{
                id: "dsml-malformed",
                objective: "DSML_MALFORMED_TASK",
                executor: "harness",
                complexity: "trivial",
                harnessMode: "minimal",
                model: "deepseek-v4-flash",
                taskFamily: "dsml-infrastructure-family",
                harnessWritePaths: ["src/harness/malformed-must-not-exist.json"],
                acceptanceCriteria: ["Malformed DSML fails closed without writing files"],
                verificationCommands: ["test ! -e src/harness/malformed-must-not-exist.json"],
                budget: { maxApiCalls: 3, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostCny: 1 },
            }],
    });
    await startTask({ planId: "dsml-malformed-plan", leafId: "dsml-malformed", taskId: "dsml-malformed-task" });
    const malformedTerminal = await waitTerminal("dsml-malformed-task");
    assert.equal(malformedTerminal.status, "failed", JSON.stringify(malformedTerminal));
    assert.equal(malformedTerminal.infrastructureFailureKind, "tool_protocol", JSON.stringify(malformedTerminal));
    assert.match(String(malformedTerminal.toolProtocolFailure), /no complete executable invoke/i);
    assert.equal(malformedTerminal.toolProtocolRecoveryCount, 0);
    const malformedCollect = payload(await collectTask("dsml-malformed-task", true, 100_000));
    assert.deepEqual(malformedCollect.changedPaths, []);
    await cleanupTask("dsml-malformed-task", true, true);
    const infrastructureAfter = payloadArray(payload(await controllerSplitAdvice(repo, [{
            id: "infra-after", taskFamily: "dsml-infrastructure-family", executor: "harness", harnessMode: "minimal", complexity: "trivial",
        }])).candidates)[0];
    assert.equal(infrastructureAfter.sampleCount, 0, JSON.stringify(infrastructureAfter));
    assert.equal(infrastructureAfter.recommendedLeafScale, 1, JSON.stringify(infrastructureAfter));
    assert.equal(infrastructureAfter.recommendedComplexity, "trivial", JSON.stringify(infrastructureAfter));
    const infrastructureMemory = payload(await controllerSplitMemory(repo));
    const infrastructureProfile = payloadArray(infrastructureMemory.profiles).find((item) => item.taskFamily === "dsml-infrastructure-family");
    assert.ok(infrastructureProfile, JSON.stringify(infrastructureMemory));
    assert.equal(infrastructureProfile.sampleCount, 0);
    assert.equal(infrastructureProfile.infrastructureFailureCount, 1);
    await createControllerPlan({
        repoRoot: repo,
        planId: "repair-plan",
        leaves: [{
                id: "repairable", objective: "CREATE_ALLOWED_FILE", executor: "harness", complexity: "small",
                harnessWritePaths: ["src/harness/**"], acceptanceCriteria: ["result and repair marker exist"],
                verificationCommands: ["test -f src/harness/result.txt && test -f src/harness/repair.txt"],
                budget: { maxApiCalls: 3, maxInputTokens: 20_000, maxOutputTokens: 2_000, maxCostCny: 1 },
            }],
    });
    await startTask({ planId: "repair-plan", leafId: "repairable", taskId: "repair-task" });
    assert.equal((await waitTerminal("repair-task")).status, "completed");
    const initialRepairCollect = payload(await collectTask("repair-task", true, 100_000));
    const initialRepairPaths = initialRepairCollect.changedPaths;
    for (const file of initialRepairPaths)
        await readChangedFile("repair-task", file);
    await reviewTask("repair-task", "revise", initialRepairPaths, "Add the mandatory repair marker.");
    const repairStart = payload(await repairTask("repair-task", "Add the mandatory repair marker."));
    const repairTaskId = String(repairStart.taskId);
    const repairTerminal = await waitTerminal(repairTaskId);
    assert.equal(repairTerminal.status, "completed", JSON.stringify(repairTerminal));
    const repairUsage = payload(repairTerminal.usage);
    assert.equal(repairUsage.apiCalls, 2, JSON.stringify(repairUsage));
    await approveVerifyCommit(repairTaskId, "test: accept repaired Harness leaf");
    await finalizeControllerPlan("repair-plan", "Codex approved repair and cumulative budget evidence.");
    await cleanupTask(repairTaskId, true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "budget-plan",
        leaves: [{
                id: "budget", objective: "TOKEN_GATE_TASK TARGET_PATH: src/harness/token-gated.txt", executor: "harness", complexity: "medium",
                taskFamily: "adaptive-token-family", splitRationale: "Initial medium leaf used to calibrate token-gate anomaly learning.",
                harnessWritePaths: ["src/harness/token-gated.txt"], acceptanceCriteria: ["must stop at input token gate"], verificationCommands: ["true"],
                budget: { maxApiCalls: 100, maxInputTokens: 105, maxOutputTokens: 1_000, maxCostCny: 100 },
            }],
    });
    await startTask({ planId: "budget-plan", leafId: "budget", taskId: "budget-task" });
    const budgetTerminal = await waitTerminal("budget-task");
    assert.equal(budgetTerminal.status, "failed", JSON.stringify(budgetTerminal));
    assert.match(String(budgetTerminal.error), /input token budget/i);
    await cleanupTask("budget-task", true, true);
    const splitAdvice = payload(await controllerSplitAdvice(repo, [{
            id: "adaptive-next", taskFamily: "adaptive-token-family", executor: "harness", harnessMode: "minimal", complexity: "medium",
        }]));
    const adaptiveCandidate = payloadArray(splitAdvice.candidates)[0];
    assert.ok(Number(adaptiveCandidate.recommendedLeafScale) < 1, JSON.stringify(adaptiveCandidate));
    assert.equal(adaptiveCandidate.recommendedComplexity, "small");
    assert.ok(Number(adaptiveCandidate.confidence) >= 0.5);
    const memorySnapshot = payload(await controllerSplitMemory(repo));
    const adaptiveProfile = payloadArray(memorySnapshot.profiles).find((item) => item.taskFamily === "adaptive-token-family");
    assert.ok(adaptiveProfile, JSON.stringify(memorySnapshot));
    assert.equal(adaptiveProfile.tokenGateExceededCount, 1);
    assert.equal(adaptiveProfile.sampleCount, 1);
    await expectFailure(() => createControllerPlan({
        repoRoot: repo,
        planId: "adaptive-oversized-plan",
        leaves: [{
                id: "adaptive-oversized", objective: "Historical anomaly should reject this medium leaf", executor: "harness", complexity: "medium",
                taskFamily: "adaptive-token-family", harnessWritePaths: ["src/harness/adaptive-oversized.txt"],
                acceptanceCriteria: ["must be rejected before launch"], verificationCommands: ["true"],
            }],
    }), /adaptive split-memory recommendation small/i);
    const adaptivePlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "adaptive-smaller-plan",
        leaves: [{
                id: "adaptive-small", objective: "TARGET_PATH: src/harness/adaptive-small.txt", executor: "harness", complexity: "small",
                taskFamily: "adaptive-token-family", splitRationale: "Reduced to a small leaf in response to the learned token-gate anomaly.",
                harnessWritePaths: ["src/harness/adaptive-small.txt"], acceptanceCriteria: ["smaller leaf completes"],
                verificationCommands: ["grep -q '^implemented$' src/harness/adaptive-small.txt"],
            }],
    }));
    const adaptiveLeaf = payloadArray(adaptivePlan.leaves)[0];
    assert.equal(payload(adaptiveLeaf.splitDecision).recommendedComplexity, "small");
    await startTask({ planId: "adaptive-smaller-plan", leafId: "adaptive-small", taskId: "adaptive-small-task" });
    assert.equal((await waitTerminal("adaptive-small-task")).status, "completed");
    await approveVerifyCommit("adaptive-small-task", "test: accept adaptively reduced leaf");
    await finalizeControllerPlan("adaptive-smaller-plan", "Codex followed split memory and verified the reduced leaf.");
    await cleanupTask("adaptive-small-task", true, true);
    await createControllerPlan({
        repoRoot: repo,
        planId: "dynamic-budget-plan",
        leaves: [{
                id: "dynamic", objective: "DYNAMIC_TOKEN_TASK", executor: "harness", complexity: "small",
                harnessWritePaths: ["src/harness/dynamic-token.txt"], acceptanceCriteria: ["finish after live input token gate expansion"],
                verificationCommands: ["grep -q 'live token gate expansion' src/harness/dynamic-token.txt"],
                budget: { maxApiCalls: 1, maxInputTokens: 105, maxOutputTokens: 1_000, maxCostCny: 0.000000001 },
            }],
    });
    await startTask({ planId: "dynamic-budget-plan", leafId: "dynamic", taskId: "dynamic-budget-task" });
    const dynamicDeadline = Date.now() + 10_000;
    let firstCallObserved = false;
    while (Date.now() < dynamicDeadline) {
        const status = payload(await taskStatus("dynamic-budget-task"));
        const taskUsage = payload(status.usage);
        if (status.status === "running" && Number(taskUsage.apiCalls) >= 1) {
            firstCallObserved = true;
            break;
        }
        await sleep(75);
    }
    assert.equal(firstCallObserved, true, "first dynamic-budget provider call was not observed while task remained active");
    const activeSnapshot = payload(await monitorSnapshot(200));
    const activeDetail = payloadArray(activeSnapshot.activeTasks).find((item) => item.taskId === "dynamic-budget-task");
    assert.ok(activeDetail, "current-task detail area has no active task payload");
    assert.equal(activeDetail.objective, "DYNAMIC_TOKEN_TASK");
    assert.deepEqual(activeDetail.acceptanceCriteria, ["finish after live input token gate expansion"]);
    await dashboardMutation(dashboardBase, csrf, "/api/budget-overrides", "POST", {
        budgetGroupId: "dynamic-budget-task",
        budget: { maxApiCalls: 1, maxInputTokens: 500, maxOutputTokens: 1_000, maxCostCny: 0.000000001, maxCostUsd: 0.000000001 },
        reason: "deterministic live expansion while the leaf is running",
    });
    const dynamicTerminal = await waitTerminal("dynamic-budget-task");
    assert.equal(dynamicTerminal.status, "completed", JSON.stringify(dynamicTerminal));
    assert.equal(payload(dynamicTerminal.budget).maxInputTokens, 500);
    assert.equal(payload(dynamicTerminal.frozenBudget).maxInputTokens, 105);
    assert.equal(payload(dynamicTerminal.usage).apiCalls, 2);
    await approveVerifyCommit("dynamic-budget-task", "test: accept dynamically token-funded leaf");
    await finalizeControllerPlan("dynamic-budget-plan", "Codex verified live token gate expansion and output.");
    await cleanupTask("dynamic-budget-task", true, true);
    const autoPlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "llama-plan",
        leaves: [{
                id: "local", objective: "Generate one deterministic local leaf file", complexity: "trivial",
                harnessWritePaths: ["src/local/generated.txt"], acceptanceCriteria: ["file identifies local generator"],
                contextFiles: ["README.md"], verificationCommands: ["grep -q 'local llama.cpp' src/local/generated.txt"],
                budget: { maxApiCalls: 2, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostCny: 0.5 },
            }],
    }));
    const autoLeaf = payloadArray(autoPlan.leaves)[0];
    assert.equal(autoLeaf.requestedExecutor, "auto");
    assert.equal(autoLeaf.executor, "llama_cpp");
    await startTask({ planId: "llama-plan", leafId: "local", taskId: "llama-task" });
    const llamaTerminal = await waitTerminal("llama-task");
    assert.equal(llamaTerminal.status, "completed", JSON.stringify(llamaTerminal));
    assert.equal(llamaTerminal.fallbackUsed, false);
    assert.equal((payload(llamaTerminal.usage)).apiCalls, 1);
    await approveVerifyCommit("llama-task", "test: accept auto-routed llama.cpp leaf");
    await finalizeControllerPlan("llama-plan", "Codex reviewed exact local output and ran frozen verification.");
    await cleanupTask("llama-task", true, true);
    async function runFallbackCase(planId, leafId, taskId, objective, output, expectedText) {
        const fallbackPlan = payload(await createControllerPlan({
            repoRoot: repo,
            planId,
            leaves: [{
                    id: leafId, objective, complexity: "trivial",
                    harnessWritePaths: [output], acceptanceCriteria: ["Harness fallback writes the exact leased file"],
                    verificationCommands: [`grep -q ${JSON.stringify(expectedText)} ${JSON.stringify(output)}`],
                    budget: { maxApiCalls: 4, maxInputTokens: 20_000, maxOutputTokens: 2_000, maxCostCny: 1 },
                }],
        }));
        assert.equal(payloadArray(fallbackPlan.leaves)[0].executor, "llama_cpp");
        await startTask({ planId, leafId, taskId });
        const fallbackTerminal = await waitTerminal(taskId, 60_000);
        assert.equal(fallbackTerminal.status, "completed", JSON.stringify(fallbackTerminal));
        assert.equal(fallbackTerminal.fallbackUsed, true);
        assert.equal(fallbackTerminal.fallbackModel, "deepseek-v4-flash");
        assert.equal(fallbackTerminal.effectiveExecutor, "harness");
        const attempts = payloadArray(fallbackTerminal.executionAttempts);
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].executor, "llama_cpp");
        assert.equal(attempts[1].executor, "harness");
        assert.equal(attempts[1].model, "deepseek-v4-flash");
        await approveVerifyCommit(taskId, `test: accept ${taskId} fallback`);
        await finalizeControllerPlan(planId, "Codex approved controlled llama.cpp to Harness fallback.");
        await cleanupTask(taskId, true, true);
    }
    await runFallbackCase("llama-error-fallback-plan", "local-error", "llama-error-fallback-task", "LLAMA_FALLBACK_TASK LLAMA_FORCE_ERROR", "src/local/fallback.txt", "Harness deepseek-v4-flash fallback");
    await runFallbackCase("llama-omission-plan", "local-omit", "llama-omission-task", "LLAMA_OMIT_OUTPUT", "src/local/omitted.txt", "deepseek-v4-flash fallback after invalid local output");
    await runFallbackCase("llama-timeout-plan", "local-timeout", "llama-timeout-task", "LLAMA_TIMEOUT_TASK LLAMA_FORCE_TIMEOUT", "src/local/timeout.txt", "deepseek-v4-flash fallback after local timeout");
    const managedConfig = await dashboardMutation(dashboardBase, csrf, "/api/llama/config", "POST", {
        config: {
            enabled: true,
            autoRouteSimpleLeaves: true,
            mode: "managed_server",
            baseUrl: `http://127.0.0.1:${managedLlamaPort}/v1`,
            model: "managed-acceptance-model",
            serverBinary: process.execPath,
            serverArgs: [fakeManagedServer],
            serverAutoStart: false,
            serverStartupTimeoutSeconds: 10,
            fallbackEnabled: true,
            fallbackModel: "deepseek-v4-flash",
        },
    });
    assert.equal(payload(managedConfig.settings).mode, "managed_server");
    const managedStart = await dashboardMutation(dashboardBase, csrf, "/api/llama/server/start", "POST", {});
    assert.equal(managedStart.ok, true, JSON.stringify(managedStart));
    assert.equal(managedStart.running, true);
    const managedProbe = await dashboardMutation(dashboardBase, csrf, "/api/llama/probe", "POST", {});
    assert.equal(managedProbe.ok, true, JSON.stringify(managedProbe));
    const managedStop = await dashboardMutation(dashboardBase, csrf, "/api/llama/server/stop", "POST", {});
    assert.equal(managedStop.ok, true, JSON.stringify(managedStop));
    assert.equal(managedStop.stopped, true);
    const cliConfig = await dashboardMutation(dashboardBase, csrf, "/api/llama/config", "POST", {
        config: {
            enabled: true,
            autoRouteSimpleLeaves: true,
            mode: "cli",
            model: "custom-cli-model",
            cliBinary: process.execPath,
            cliArgs: [fakeLlamaCli, "--prompt-file", "{{PROMPT_FILE}}", "--output", "{{OUTPUT_JSON_FILE}}", "--model", "{{MODEL}}"],
            requestTimeoutSeconds: 10,
            fallbackEnabled: true,
            fallbackModel: "deepseek-v4-flash",
        },
    });
    assert.equal(payload(cliConfig.settings).mode, "cli");
    const cliProbe = await dashboardMutation(dashboardBase, csrf, "/api/llama/probe", "POST", {});
    assert.equal(cliProbe.ok, true, JSON.stringify(cliProbe));
    const cliPlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "llama-cli-plan",
        leaves: [{
                id: "cli", objective: "Generate one file through custom llama-cli args", complexity: "small",
                harnessWritePaths: ["src/local/cli.txt"], acceptanceCriteria: ["custom CLI adapter writes exact output"],
                verificationCommands: ["grep -q 'custom llama-cli' src/local/cli.txt"],
                budget: { maxApiCalls: 2, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostCny: 0.5 },
            }],
    }));
    assert.equal(payloadArray(cliPlan.leaves)[0].executor, "llama_cpp");
    await startTask({ planId: "llama-cli-plan", leafId: "cli", taskId: "llama-cli-task" });
    const cliTerminal = await waitTerminal("llama-cli-task");
    assert.equal(cliTerminal.status, "completed", JSON.stringify(cliTerminal));
    assert.equal(cliTerminal.fallbackUsed, false);
    await approveVerifyCommit("llama-cli-task", "test: accept custom llama-cli leaf");
    await finalizeControllerPlan("llama-cli-plan", "Codex reviewed custom CLI output.");
    await cleanupTask("llama-cli-task", true, true);
    await dashboardMutation(dashboardBase, csrf, "/api/llama/config", "POST", { config: { enabled: false } });
    const disabledPlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "llama-disabled-routing-plan",
        leaves: [{
                id: "disabled-route", objective: "exact simple file while local model is disabled", complexity: "trivial",
                harnessWritePaths: ["src/local/disabled.txt"], acceptanceCriteria: ["route only"], verificationCommands: ["true"],
            }],
    }));
    const disabledLeaf = payloadArray(disabledPlan.leaves)[0];
    assert.equal(disabledLeaf.executor, "harness");
    assert.match(String(disabledLeaf.routingReason), /disabled/i);
    await dashboardMutation(dashboardBase, csrf, "/api/llama/config", "POST", {
        config: {
            enabled: true,
            mode: "external_server",
            baseUrl: `http://127.0.0.1:${llamaPort}/v1`,
            model: "acceptance-local-model",
            requestTimeoutSeconds: 1,
            fallbackEnabled: true,
            fallbackModel: "deepseek-v4-flash",
        },
    });
    await createControllerPlan({
        repoRoot: repo,
        planId: "scope-plan",
        leaves: [{
                id: "scope", objective: "SCOPE_VIOLATION", executor: "harness", complexity: "small",
                harnessWritePaths: ["src/harness/**"], acceptanceCriteria: ["must reject scope escape"], verificationCommands: ["true"],
            }],
    });
    await startTask({ planId: "scope-plan", leafId: "scope", taskId: "scope-task" });
    const scope = await waitTerminal("scope-task");
    assert.equal(scope.status, "scope_violation", JSON.stringify(scope));
    await cleanupTask("scope-task", true, true);
    const parallelPlan = payload(await createControllerPlan({
        repoRoot: repo,
        planId: "parallel-minimal-plan",
        leaves: [
            {
                id: "parallel-a", objective: "PARALLEL_DELAY_TASK TARGET_PATH: src/slow/a.txt", executor: "harness", complexity: "large",
                model: "deepseek-v4-pro", harnessMode: "minimal", parallelGroup: "complex-build",
                harnessWritePaths: ["src/slow/a.txt"], acceptanceCriteria: ["parallel leaf A completes"],
                verificationCommands: ["grep -q '^implemented$' src/slow/a.txt"],
                budget: { maxApiCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostCny: 0.000000001 },
            },
            {
                id: "parallel-b", objective: "PARALLEL_DELAY_TASK TARGET_PATH: src/second/b.txt", executor: "harness", complexity: "large",
                model: "deepseek-v4-pro", harnessMode: "minimal", parallelGroup: "complex-build",
                harnessWritePaths: ["src/second/b.txt"], acceptanceCriteria: ["parallel leaf B completes"],
                verificationCommands: ["grep -q '^implemented$' src/second/b.txt"],
                budget: { maxApiCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostCny: 0.000000001 },
            },
        ],
    }));
    for (const leaf of payloadArray(parallelPlan.leaves)) {
        assert.equal(leaf.harnessMode, "minimal");
        assert.equal(leaf.parallelGroup, "complex-build");
        assert.equal(leaf.complexity, "large");
    }
    await Promise.all([
        startTask({ planId: "parallel-minimal-plan", leafId: "parallel-a", taskId: "parallel-a-task" }),
        startTask({ planId: "parallel-minimal-plan", leafId: "parallel-b", taskId: "parallel-b-task" }),
    ]);
    const overlapDeadline = Date.now() + 10_000;
    let simultaneous = false;
    while (Date.now() < overlapDeadline) {
        const [a, b] = [payload(await taskStatus("parallel-a-task")), payload(await taskStatus("parallel-b-task"))];
        if (a.status === "running" && b.status === "running") {
            simultaneous = true;
            break;
        }
        await sleep(50);
    }
    assert.equal(simultaneous, true, "two disjoint minimal Harness leaves never overlapped in running state");
    assert.equal((await waitTerminal("parallel-a-task", 60_000)).status, "completed");
    assert.equal((await waitTerminal("parallel-b-task", 60_000)).status, "completed");
    await approveVerifyCommit("parallel-a-task", "test: accept parallel minimal leaf A");
    await approveVerifyCommit("parallel-b-task", "test: accept parallel minimal leaf B");
    await finalizeControllerPlan("parallel-minimal-plan", "Codex independently reviewed and verified both concurrent minimal leaves.");
    await cleanupTask("parallel-a-task", true, true);
    await cleanupTask("parallel-b-task", true, true);
    const policyMutation = await dashboardMutation(dashboardBase, csrf, "/api/budget-policy", "POST", {
        defaultHarnessBudget: { maxApiCalls: 5, maxInputTokens: 25_000, maxOutputTokens: 5_000, maxCostCny: 3, maxCostUsd: 0.4 },
        maximumHarnessBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "operator_bounded", enforcement: "hard", maxApiCalls: 10, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostCny: 10, maxCostUsd: 1 },
        defaultProComplexBudget: { gatePolicy: "input_output_tokens", ceilingPolicy: "unbounded", enforcement: "hard", maxApiCalls: 240, maxInputTokens: 8_000_000, maxOutputTokens: 1_000_000, maxCostCny: 720, maxCostUsd: 100 },
        reason: "deterministic dashboard policy update",
    });
    const policy = payload(policyMutation.policy);
    assert.equal(payload(policy.defaultHarnessBudget).maxCostCny, 3);
    assert.equal(payload(policy.defaultProComplexBudget).maxApiCalls, 240);
    assert.equal(payload(policy.defaultProComplexBudget).enforcement, "hard");
    assert.equal(payload(policy.defaultProComplexBudget).gatePolicy, "input_output_tokens");
    const auditResponse = await fetch(`${dashboardBase}/api/budget-audit`);
    assert.equal(auditResponse.status, 200);
    const audit = payload(await auditResponse.json());
    assert.ok(payloadArray(audit.events).some((item) => item.scope === "policy"));
    assert.ok(payloadArray(audit.events).some((item) => item.budgetGroupId === "dynamic-budget-task"));
    const correction = await dashboardMutation(dashboardBase, csrf, "/api/cost-corrections", "POST", {
        budgetGroupId: "harness-task",
        correctedCostCny: 0.5,
        reason: "deterministic provider invoice fixture in CNY",
    });
    assert.equal(correction.ok, true);
    const adjustmentsResponse = await fetch(`${dashboardBase}/api/adjustments`);
    assert.equal(adjustmentsResponse.status, 200);
    const adjustmentsPayload = payload(await adjustmentsResponse.json());
    assert.equal(payloadArray(adjustmentsPayload.adjustments).length, 1);
    const snapshot = payload(await monitorSnapshot(200));
    assert.equal(snapshot.costSemantics, "configured_pricing_estimate_cny_primary");
    assert.equal(snapshot.billingAuthoritative, false);
    assert.equal(snapshot.budgetUsesManualAdjustments, false);
    assert.equal(payload(snapshot.budgetControls).proComplexExecutionHasHardTokenGates, true);
    assert.equal(payload(snapshot.budgetControls).apiCallsAndCostAreReferenceOnly, true);
    assert.ok(payload(snapshot.adaptiveSplitMemory).profiles instanceof Array);
    assert.equal(snapshot.primaryCurrency, "CNY");
    assert.equal(snapshot.currencySymbol, "CN¥");
    assert.equal(snapshot.showUsd, false);
    assert.ok(Number(snapshot.totalCostCny) > 0);
    assert.ok(Number(snapshot.manualAdjustmentCny) > 0);
    assert.equal(Number(snapshot.liveEstimatedCostCny), 0);
    assert.equal(snapshot.totalCostUsd, undefined);
    assert.equal(snapshot.liveEstimatedCostUsd, undefined);
    assert.ok(Array.isArray(snapshot.tasks));
    assert.ok(Array.isArray(snapshot.activeTasks));
    assert.equal((await readFile(path.join(stateRoot, "monitor", "snapshot.json"), "utf8")).includes("acceptance-secret-not-persisted"), false);
    acceptanceTrace("stopping temporary monitor");
    const stoppedMonitor = payload(await monitorStop());
    assert.equal(stoppedMonitor.stopped, true);
    acceptanceTrace("temporary monitor stopped; writing PASS summary");
    process.stdout.write(`${JSON.stringify({
        result: "PASS",
        version: "0.6.4",
        controllerPlan: "harness-plan",
        proComplexPlan: "pro-complex-plan",
        proComplexModel: "deepseek-v4-pro",
        proComplexBudgetEnforcement: "hard",
        proComplexTokenGateHardStop: true,
        apiCallsAndCostReferenceOnly: true,
        adaptiveSplitMemory: "PASS",
        splitMemoryInfrastructureIsolation: "PASS",
        dsmlToolCallRecovery: "PASS",
        markdownShellToolCallRecovery: "PASS",
        textualToolCallEnvelopeRecovery: "PASS",
        minimalFlashRequiredToolChoice: "PASS",
        requiredToolChoiceViolationFailsClosed: "PASS",
        nativeStructuredToolEvidence: "PASS",
        auxiliaryTitleIsolationBeforeMutation: "PASS",
        requiredChangeNoEffectIsolation: "PASS",
        malformedDsmlFailsClosed: "PASS",
        parallelMinimalHarness: "PASS",
        harnessTask: "harness-task",
        repairTask: repairTaskId,
        monitoredApiCalls: providerCalls,
        monitoredCostCny: Number(snapshot.totalCostCny),
        realtimeStreamingCnyObserved: true,
        liveBudgetAdjustmentObserved: true,
        manualCnyReconciliationObserved: true,
        uiTabs: ["任务", "费用", "本地模型"],
        defaultUsdDisplay: false,
        dashboardTheme: "soft-light",
        autoRoutedLlamaTask: "llama-task",
        fallbackTasks: ["llama-error-fallback-task", "llama-omission-task", "llama-timeout-task"],
        fallbackModel: "deepseek-v4-flash",
        providerModels: [...new Set(providerModels)],
        customLlamaCliTask: "llama-cli-task",
        managedLlamaServerLifecycle: "PASS",
        scopeTask: "scope-task",
        llamaCalls,
        harnessCommit: harnessCommit.commit,
        costSemantics: snapshot.costSemantics,
        billingAuthoritative: snapshot.billingAuthoritative,
    }, null, 2)}\n`);
}
catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[direct-acceptance failure before cleanup] ${message}\n`);
    throw error;
}
finally {
    acceptanceTrace("finally: monitor stop begin");
    try {
        await monitorStop();
    }
    catch { /* best effort */ }
    acceptanceTrace("finally: provider server close begin");
    await closeServer(providerServer);
    acceptanceTrace("finally: llama server close begin");
    await closeServer(llamaServer);
    acceptanceTrace("finally: temp cleanup begin");
    if (process.env.KEEP_CODEX_HARNESS_ACCEPTANCE !== "1")
        await rm(temp, { recursive: true, force: true });
    acceptanceTrace("finally: cleanup complete");
}
// Acceptance is a one-shot CLI. Exit after all explicit cleanup so lingering
// HTTP client keep-alive handles cannot stall release automation.
process.exit(0);
//# sourceMappingURL=direct-acceptance.js.map