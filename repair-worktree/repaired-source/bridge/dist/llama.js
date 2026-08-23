import { closeSync, openSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { effectiveBudget, effectiveLlamaConfig } from "./controls.js";
import { loadPlan, withNamedLock } from "./store.js";
import { appendUsageEvent, budgetExceededReason, estimateTokens, markBudgetExceeded, parseProviderUsage, projectedBudgetExceededReason, usageEventId, usageForBudgetGroup, writeUsageSnapshot, } from "./telemetry.js";
import { atomicWriteJson, ensureDir, isWithin, normalizeRepoRelative, nowIso, pathExists, readJson, runProcess, sleep } from "./util.js";
import { captureSettledProcessIdentity, processIdentityMatches, sha256Executable, signalVerifiedProcessGroup, } from "./process-identity.js";
export class LlamaExecutionError extends Error {
    code;
    fallbackEligible;
    constructor(code, message, fallbackEligible = code !== "budget" && code !== "security") {
        super(message);
        this.name = "LlamaExecutionError";
        this.code = code;
        this.fallbackEligible = fallbackEligible;
    }
}
function runtimeRoot(config) {
    return path.join(config.stateRoot, "llama-runtime");
}
function managedStatePath(config) {
    return path.join(runtimeRoot(config), "managed-server.json");
}
function managedLogPath(config) {
    return path.join(runtimeRoot(config), "managed-server.log");
}
function serverHealthUrl(settings) {
    const url = new URL(settings.baseUrl);
    url.pathname = url.pathname.replace(/\/v1\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return new URL("health", url.toString().replace(/\/?$/, "/")).toString();
}
async function fetchTimeout(url, init, timeoutSeconds) {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutSeconds) * 1_000) });
}
function commandArgs(settings, args, variables) {
    return args.map((argument) => argument.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => variables[name] ?? `{{${name}}}`));
}
function commandDisplay(command, args) {
    return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}
async function readManagedState(config) {
    const target = managedStatePath(config);
    if (!await pathExists(target))
        return undefined;
    try {
        const state = await readJson(target);
        return state.schemaVersion === 2 && state.identity !== undefined ? state : undefined;
    }
    catch {
        return undefined;
    }
}
function localModelEnvironment(config) {
    const env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: runtimeRoot(config),
        LANG: process.env.LANG ?? "C.UTF-8",
        NO_COLOR: "1",
    };
    const key = process.env.LLAMA_CPP_API_KEY;
    if (key !== undefined)
        env.LLAMA_CPP_API_KEY = key;
    if (process.env.LC_ALL !== undefined)
        env.LC_ALL = process.env.LC_ALL;
    if (process.env.SSL_CERT_FILE !== undefined)
        env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    return env;
}
async function pinnedExecutable(command, expectedSha256, label) {
    if (!path.isAbsolute(command))
        throw new LlamaExecutionError("security", `${label} must be an absolute allowlisted path`, false);
    if (!expectedSha256)
        throw new LlamaExecutionError("security", `${label} has no SHA-256 allowlist pin`, false);
    const actual = await sha256Executable(command);
    if (new Set([
        "bash", "busybox", "dash", "env", "node", "nodejs", "perl", "php", "pwsh",
        "python", "python2", "python3", "ruby", "sh", "zsh",
    ]).has(path.basename(actual.realpath).toLowerCase())) {
        throw new LlamaExecutionError("security", `${label} must not be a general-purpose interpreter: ${actual.realpath}`, false);
    }
    if (actual.sha256 !== expectedSha256) {
        throw new LlamaExecutionError("security", `${label} SHA-256 mismatch for ${actual.realpath}`, false);
    }
    return actual.realpath;
}
async function httpProbe(settings) {
    const headers = new Headers();
    const apiKey = process.env.LLAMA_CPP_API_KEY;
    if (apiKey)
        headers.set("authorization", `Bearer ${apiKey}`);
    const result = { mode: settings.mode, baseUrl: settings.baseUrl, model: settings.model };
    try {
        const health = await fetchTimeout(serverHealthUrl(settings), { headers }, 5);
        result.health = { status: health.status, ok: health.ok, body: (await health.text()).slice(0, 2_000) };
    }
    catch (error) {
        result.health = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
        const models = await fetchTimeout(`${settings.baseUrl}/models`, { headers }, 5);
        result.models = { status: models.status, ok: models.ok, body: (await models.text()).slice(0, 8_000) };
        result.ok = models.ok;
    }
    catch (error) {
        result.models = { ok: false, error: error instanceof Error ? error.message : String(error) };
        result.ok = false;
    }
    return result;
}
export async function managedLlamaServerStatus(config, includeProbe = false) {
    const settings = await effectiveLlamaConfig(config);
    const state = await readManagedState(config);
    const running = await processIdentityMatches(state?.identity);
    const probe = includeProbe && settings.mode === "managed_server" && running ? await httpProbe(settings) : undefined;
    return {
        enabled: settings.enabled,
        mode: settings.mode,
        running,
        state,
        probe,
        settings,
    };
}
export async function startManagedLlamaServer(config) {
    return await withNamedLock(config, "llama-managed-server", 30_000, async () => {
        const settings = await effectiveLlamaConfig(config);
        if (!settings.enabled)
            throw new Error("llama.cpp is disabled");
        if (settings.mode !== "managed_server")
            throw new Error("managed server start requires llama.cpp mode=managed_server");
        const existing = await readManagedState(config);
        if (await processIdentityMatches(existing?.identity))
            return await managedLlamaServerStatus(config, true);
        await ensureDir(runtimeRoot(config));
        await rm(managedStatePath(config), { force: true });
        const variables = { MODEL: settings.model, BASE_URL: settings.baseUrl };
        const args = commandArgs(settings, settings.serverArgs, variables);
        const logFd = openSync(managedLogPath(config), "a", 0o600);
        const executable = await pinnedExecutable(settings.serverBinary, settings.serverBinarySha256, "llama.cpp serverBinary");
        const child = spawn(executable, args, {
            detached: process.platform !== "win32",
            cwd: settings.workingDirectory,
            env: localModelEnvironment(config),
            stdio: ["ignore", logFd, logFd],
        });
        try {
            await new Promise((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            if (!child.pid)
                throw new Error("managed llama-server spawned without PID");
            const identity = await captureSettledProcessIdentity(child.pid);
            if (identity.processGroupId !== identity.pid)
                throw new Error("managed llama-server did not become its process-group leader");
            const state = {
                schemaVersion: 2,
                pid: child.pid,
                identity,
                startedAt: nowIso(),
                command: executable,
                args,
                baseUrl: settings.baseUrl,
                logPath: managedLogPath(config),
            };
            await atomicWriteJson(managedStatePath(config), state);
            child.unref();
            const deadline = Date.now() + settings.serverStartupTimeoutSeconds * 1_000;
            while (Date.now() < deadline) {
                if (!await processIdentityMatches(identity))
                    throw new Error(`managed llama-server exited during startup; inspect ${state.logPath}`);
                const probe = await httpProbe(settings);
                if (probe.ok === true)
                    return { ok: true, started: true, ...await managedLlamaServerStatus(config, true) };
                await sleep(250);
            }
            await signalVerifiedProcessGroup(identity, "SIGTERM");
            throw new Error(`managed llama-server did not become healthy within ${settings.serverStartupTimeoutSeconds}s; inspect ${state.logPath}`);
        }
        finally {
            closeSync(logFd);
        }
    });
}
export async function stopManagedLlamaServer(config) {
    return await withNamedLock(config, "llama-managed-server", 30_000, async () => {
        const state = await readManagedState(config);
        if (!state?.identity || !await processIdentityMatches(state.identity)) {
            await rm(managedStatePath(config), { force: true });
            return { ok: true, stopped: false };
        }
        await signalVerifiedProcessGroup(state.identity, "SIGTERM");
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && await processIdentityMatches(state.identity))
            await sleep(50);
        if (await processIdentityMatches(state.identity)) {
            await signalVerifiedProcessGroup(state.identity, "SIGKILL");
        }
        await rm(managedStatePath(config), { force: true });
        return { ok: !await processIdentityMatches(state.identity), stopped: true, pid: state.pid };
    });
}
export async function probeLlamaCpp(config) {
    const settings = await effectiveLlamaConfig(config);
    if (!settings.enabled)
        return { enabled: false, ok: true, reason: "disabled by operator control", settings };
    if (settings.mode === "cli") {
        const executable = await pinnedExecutable(settings.cliBinary, settings.cliBinarySha256, "llama.cpp cliBinary");
        const options = {
            timeoutMs: 5_000,
            maxCaptureChars: 8_000,
            killProcessGroup: true,
            env: localModelEnvironment(config),
        };
        if (settings.workingDirectory)
            options.cwd = settings.workingDirectory;
        const result = await runProcess(executable, ["--version"], options);
        return {
            enabled: true, mode: settings.mode, ok: result.code === 0,
            command: executable, code: result.code, timedOut: result.timedOut,
            stdout: result.stdout.trim(), stderr: result.stderr.trim(), settings,
        };
    }
    if (settings.mode === "managed_server" && settings.serverAutoStart) {
        const state = await readManagedState(config);
        if (!await processIdentityMatches(state?.identity)) {
            try {
                await startManagedLlamaServer(config);
            }
            catch (error) {
                return { enabled: true, mode: settings.mode, ok: false, error: error instanceof Error ? error.message : String(error), settings };
            }
        }
    }
    return { enabled: true, ...await httpProbe(settings), settings, managed: settings.mode === "managed_server" ? await readManagedState(config) : undefined };
}
function exactOutputLeases(task) {
    const outputs = task.harnessWritePaths.map(normalizeRepoRelative);
    if (outputs.some((item) => item === "**" || item.endsWith("/**")))
        throw new LlamaExecutionError("security", "llama.cpp requires exact output file leases", false);
    return [...new Set(outputs)];
}
async function readContext(settings, task) {
    if (task.contextFiles.length > settings.maxContextFiles) {
        throw new LlamaExecutionError("security", `llama.cpp context exceeds ${settings.maxContextFiles} files`, false);
    }
    const context = [];
    let total = 0;
    for (const relative of task.contextFiles) {
        const absolute = path.resolve(task.worktreePath, normalizeRepoRelative(relative));
        if (!isWithin(absolute, task.worktreePath))
            throw new LlamaExecutionError("security", `context path escapes worktree: ${relative}`, false);
        const canonicalRoot = await realpath(task.worktreePath);
        const canonical = await realpath(absolute);
        if (!isWithin(canonical, canonicalRoot))
            throw new LlamaExecutionError("security", `context path resolves outside worktree: ${relative}`, false);
        const info = await lstat(canonical);
        if (!info.isFile() || info.isSymbolicLink())
            throw new LlamaExecutionError("security", `context must be a regular file: ${relative}`, false);
        const content = await readFile(canonical, "utf8");
        total += Buffer.byteLength(content, "utf8");
        if (total > settings.maxContextBytes)
            throw new LlamaExecutionError("security", `llama.cpp context exceeds ${settings.maxContextBytes} bytes`, false);
        context.push({ path: relative, content });
    }
    return context;
}
function taskPrompt(task, outputs, context) {
    return [
        "You are executing one bounded leaf task. Return only one JSON object, without Markdown fences.",
        `Objective: ${task.objective}`,
        `Required output paths: ${JSON.stringify(outputs)}`,
        `Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}`,
        "Output schema: {\"files\":[{\"path\":\"exact/path\",\"content\":\"complete file content\"}],\"summary\":\"brief factual summary\"}",
        "Every required path must appear exactly once. Do not emit extra paths. Emit complete file contents, not patches.",
        ...context.map((item) => `\n--- CONTEXT ${item.path} ---\n${item.content}\n--- END CONTEXT ---`),
    ].join("\n");
}
function responseText(value) {
    if (!value || typeof value !== "object")
        throw new LlamaExecutionError("invalid_output", "llama.cpp returned a non-object response");
    const choices = value.choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object")
        throw new LlamaExecutionError("invalid_output", "llama.cpp response has no choices[0]");
    const message = choices[0].message;
    if (!message || typeof message !== "object")
        throw new LlamaExecutionError("invalid_output", "llama.cpp response has no message");
    const content = message.content;
    if (typeof content !== "string" || !content.trim())
        throw new LlamaExecutionError("invalid_output", "llama.cpp response message content is empty");
    return content;
}
function parseEnvelope(text) {
    let value;
    const trimmed = text.trim();
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start)
            throw new LlamaExecutionError("invalid_output", "llama.cpp response did not contain a JSON object");
        try {
            value = JSON.parse(trimmed.slice(start, end + 1));
        }
        catch {
            throw new LlamaExecutionError("invalid_output", "llama.cpp response JSON is invalid");
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new LlamaExecutionError("invalid_output", "llama.cpp output envelope must be an object");
    const record = value;
    if (!Array.isArray(record.files))
        throw new LlamaExecutionError("invalid_output", "llama.cpp output envelope must contain a files array");
    const files = record.files.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw new LlamaExecutionError("invalid_output", `llama.cpp files[${index}] must be an object`);
        const candidate = item;
        if (typeof candidate.path !== "string" || typeof candidate.content !== "string")
            throw new LlamaExecutionError("invalid_output", `llama.cpp files[${index}] requires string path and content`);
        return { path: normalizeRepoRelative(candidate.path), content: candidate.content };
    });
    const envelope = { files };
    if (typeof record.summary === "string")
        envelope.summary = record.summary.slice(0, 8_000);
    return envelope;
}
async function assertSafeOutputPath(worktree, relative) {
    const target = path.resolve(worktree, relative);
    if (!isWithin(target, worktree))
        throw new LlamaExecutionError("security", `llama.cpp output escapes worktree: ${relative}`, false);
    let current = worktree;
    const pieces = relative.split("/");
    for (const piece of pieces.slice(0, -1)) {
        current = path.join(current, piece);
        if (await pathExists(current)) {
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new LlamaExecutionError("security", `llama.cpp output traverses a non-directory or symlink: ${relative}`, false);
        }
    }
    if (await pathExists(target)) {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink())
            throw new LlamaExecutionError("security", `llama.cpp output target must be a regular file: ${relative}`, false);
    }
    return target;
}
async function validateOutputs(settings, task, expected, envelope) {
    if (envelope.files.length > settings.maxFilesPerTask)
        throw new LlamaExecutionError("invalid_output", `llama.cpp returned more than ${settings.maxFilesPerTask} files`);
    const seen = new Set();
    const validated = [];
    for (const file of envelope.files) {
        if (seen.has(file.path))
            throw new LlamaExecutionError("invalid_output", `llama.cpp returned duplicate output path: ${file.path}`);
        seen.add(file.path);
        if (!expected.includes(file.path))
            throw new LlamaExecutionError("invalid_output", `llama.cpp returned unleased output path: ${file.path}`);
        if (file.content.includes("\0"))
            throw new LlamaExecutionError("invalid_output", `llama.cpp output contains NUL: ${file.path}`);
        const bytes = Buffer.byteLength(file.content, "utf8");
        if (bytes > settings.maxFileBytes)
            throw new LlamaExecutionError("invalid_output", `llama.cpp output exceeds ${settings.maxFileBytes} bytes: ${file.path}`);
        validated.push({ relative: file.path, target: await assertSafeOutputPath(task.worktreePath, file.path), content: file.content });
    }
    const missing = expected.filter((item) => !seen.has(item));
    if (missing.length)
        throw new LlamaExecutionError("invalid_output", `llama.cpp omitted required output paths: ${missing.join(", ")}`);
    return validated;
}
async function publishFiles(files) {
    for (const file of files) {
        await mkdir(path.dirname(file.target), { recursive: true, mode: 0o755 });
        const temporary = `${file.target}.codex-harness-${process.pid}-${Date.now()}.tmp`;
        try {
            await writeFile(temporary, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await rename(temporary, file.target);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
async function runHttp(config, settings, task, prompt, maxOutput) {
    if (settings.mode === "managed_server" && settings.serverAutoStart)
        await startManagedLlamaServer(config);
    const headers = new Headers({ "content-type": "application/json" });
    const apiKey = process.env.LLAMA_CPP_API_KEY;
    if (apiKey)
        headers.set("authorization", `Bearer ${apiKey}`);
    const started = Date.now();
    let response;
    try {
        response = await fetchTimeout(`${settings.baseUrl}/chat/completions`, {
            method: "POST", headers,
            body: JSON.stringify({
                model: task.model ?? settings.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0,
                max_tokens: maxOutput,
                response_format: { type: "json_object" },
                stream: false,
            }),
        }, Math.min(task.runtimeSeconds, settings.requestTimeoutSeconds));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /timeout|abort/i.test(message) ? "timeout" : "unavailable";
        throw new LlamaExecutionError(code, `llama.cpp server request failed: ${message}`);
    }
    const responseBody = await response.text();
    if (!response.ok)
        throw new LlamaExecutionError("http", `llama.cpp HTTP ${response.status}: ${responseBody.slice(0, 2_000)}`);
    let payload;
    try {
        payload = JSON.parse(responseBody);
    }
    catch {
        throw new LlamaExecutionError("invalid_output", "llama.cpp returned invalid response JSON");
    }
    const content = responseText(payload);
    const providerUsage = parseProviderUsage(payload.usage);
    return {
        content,
        inputTokens: providerUsage?.inputTokens ?? estimateTokens(prompt, 4),
        outputTokens: providerUsage?.outputTokens ?? estimateTokens(content, 4),
        httpStatus: response.status,
        latencyMs: Date.now() - started,
    };
}
async function runCli(config, settings, task, prompt, maxOutput) {
    const promptPath = path.join(path.dirname(task.promptPath), "llama-cli-prompt.txt");
    const outputPath = path.join(path.dirname(task.promptPath), "llama-cli-output.json");
    await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    await rm(outputPath, { force: true });
    const variables = {
        PROMPT_FILE: promptPath,
        OUTPUT_JSON_FILE: outputPath,
        MAX_TOKENS: String(maxOutput),
        MODEL: task.model ?? settings.model,
        WORKTREE: task.worktreePath,
    };
    if (settings.cliArgs.some((arg) => arg.includes("{{PROMPT}}")))
        throw new LlamaExecutionError("security", "llama.cpp prompt text is forbidden in argv", false);
    const containsPromptFile = settings.cliArgs.some((arg) => arg.includes("{{PROMPT_FILE}}"));
    if (!containsPromptFile)
        throw new LlamaExecutionError("process", "llama.cpp cliArgs must include {{PROMPT_FILE}}");
    const args = commandArgs(settings, settings.cliArgs, variables);
    const executable = await pinnedExecutable(settings.cliBinary, settings.cliBinarySha256, "llama.cpp cliBinary");
    const started = Date.now();
    try {
        const result = await runProcess(executable, args, {
            cwd: settings.workingDirectory ?? task.worktreePath,
            env: localModelEnvironment(config),
            timeoutMs: Math.min(task.runtimeSeconds, settings.requestTimeoutSeconds) * 1_000,
            maxCaptureChars: Math.max(1_000_000, settings.maxFileBytes * settings.maxFilesPerTask * 2),
            killProcessGroup: true,
        });
        if (result.stderr)
            await writeFile(task.stderrPath, `[llama-cli ${commandDisplay(executable, args)}]\n${result.stderr}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
        if (result.timedOut)
            throw new LlamaExecutionError("timeout", `llama-cli exceeded ${Math.min(task.runtimeSeconds, settings.requestTimeoutSeconds)} seconds`);
        if (result.code !== 0)
            throw new LlamaExecutionError("process", `llama-cli exited with code ${result.code}: ${result.stderr.slice(-2_000)}`);
        const content = await pathExists(outputPath) ? await readFile(outputPath, "utf8") : result.stdout;
        if (!content.trim())
            throw new LlamaExecutionError("invalid_output", "llama-cli produced no JSON output");
        return {
            content,
            inputTokens: estimateTokens(prompt, 4),
            outputTokens: estimateTokens(content, 4),
            latencyMs: Date.now() - started,
        };
    }
    finally {
        await rm(promptPath, { force: true });
        await rm(outputPath, { force: true });
    }
}
export async function runLlamaTask(config, task) {
    const settings = await effectiveLlamaConfig(config);
    if (!settings.enabled)
        throw new LlamaExecutionError("disabled", "llama.cpp executor is disabled by operator control");
    await loadPlan(config, task.planId); // identity/existence gate; v3 UI enablement is the authorization.
    if (task.executor !== "llama_cpp")
        throw new LlamaExecutionError("security", "runLlamaTask received a non-llama task", false);
    if (task.complexity !== "trivial" && task.complexity !== "small")
        throw new LlamaExecutionError("security", "llama.cpp executor is restricted to trivial or small leaves", false);
    const outputs = exactOutputLeases(task);
    if (outputs.length > settings.maxFilesPerTask)
        throw new LlamaExecutionError("security", `llama.cpp leaf exceeds ${settings.maxFilesPerTask} output files`, false);
    const context = await readContext(settings, task);
    const prompt = taskPrompt(task, outputs, context);
    const inputEstimate = estimateTokens(prompt, config.monitor.charsPerEstimatedToken);
    return await withNamedLock(config, `budget:${task.budgetGroupId}`, Math.max(30_000, task.runtimeSeconds * 1_000), async () => {
        const before = await usageForBudgetGroup(config, task.budgetGroupId);
        const budget = await effectiveBudget(config, task.budget, task.budgetGroupId);
        const maxOutput = Math.min(settings.maxOutputTokens, budget.maxOutputTokens - before.outputTokens - before.estimatedOutputTokens);
        const reason = maxOutput <= 0
            ? "llama.cpp output token budget has no remaining capacity"
            : projectedBudgetExceededReason(before, budget, inputEstimate, 0, maxOutput, 0);
        if (reason) {
            await markBudgetExceeded(config, task, reason, before);
            throw new LlamaExecutionError("budget", reason, false);
        }
        const model = task.model ?? settings.model;
        await appendUsageEvent(task, {
            id: usageEventId(), kind: "request_started", model,
            upstream: settings.mode === "cli" ? `process:${settings.cliBinary}` : new URL(settings.baseUrl).origin,
            estimatedInputTokens: inputEstimate, estimatedOutputTokens: maxOutput, usageSource: "local",
        });
        const started = Date.now();
        let execution;
        try {
            execution = settings.mode === "cli"
                ? await runCli(config, settings, task, prompt, maxOutput)
                : await runHttp(config, settings, task, prompt, maxOutput);
        }
        catch (error) {
            const selected = error instanceof LlamaExecutionError ? error : new LlamaExecutionError("process", error instanceof Error ? error.message : String(error));
            await appendUsageEvent(task, {
                id: usageEventId(), kind: "request_failed", model,
                latencyMs: Date.now() - started, estimatedInputTokens: inputEstimate, estimatedOutputTokens: 0,
                costCny: 0, costUsd: 0, usageSource: "local", error: selected.message,
            });
            throw selected;
        }
        await appendUsageEvent(task, {
            id: usageEventId(), kind: "local_completion", model,
            ...(execution.httpStatus === undefined ? {} : { httpStatus: execution.httpStatus }),
            latencyMs: execution.latencyMs,
            inputTokens: execution.inputTokens, outputTokens: execution.outputTokens,
            costCny: 0, costUsd: 0, usageSource: "local",
        });
        const after = await usageForBudgetGroup(config, task.budgetGroupId);
        const afterBudget = await effectiveBudget(config, task.budget, task.budgetGroupId);
        const afterReason = budgetExceededReason(after, afterBudget);
        if (afterReason) {
            await markBudgetExceeded(config, task, afterReason, after);
            await writeUsageSnapshot(config, task);
            throw new LlamaExecutionError("budget", afterReason, false);
        }
        const envelope = parseEnvelope(execution.content);
        const validated = await validateOutputs(settings, task, outputs, envelope);
        await publishFiles(validated);
        await writeUsageSnapshot(config, task);
        return {
            summary: envelope.summary ?? `llama.cpp (${settings.mode}) generated ${validated.length} complete files at ${nowIso()}`,
            outputTokens: execution.outputTokens,
            inputTokens: execution.inputTokens,
        };
    });
}
//# sourceMappingURL=llama.js.map