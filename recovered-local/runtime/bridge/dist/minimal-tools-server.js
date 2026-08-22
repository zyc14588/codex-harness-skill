import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadTask, taskDirectory, withNamedLock } from "./store.js";
import { atomicWriteJson, boundedText, ensureDir, isWithin, jsonToolResult, normalizeRepoRelative, nowIso, pathExists, runProcess, safeTaskId, } from "./util.js";
const CAPABILITIES = {
    repository_read: {
        description: "Bounded repository file reads and text search. No write capability.",
        tools: ["repo_read_file", "repo_search"],
    },
    verification: {
        description: "Run only the exact verification commands frozen by Codex in this leaf contract.",
        tools: ["run_verification"],
    },
    git_inspect: {
        description: "Read-only Git status and diff inspection for the isolated worktree.",
        tools: ["git_status", "git_diff"],
    },
};
const objectSchema = (properties, required = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});
const stringSchema = (maxLength = 4096) => ({ type: "string", minLength: 1, maxLength });
const integerSchema = (minimum, maximum, defaultValue) => ({
    type: "integer",
    minimum,
    maximum,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
function asObject(value) {
    if (value === undefined)
        return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("arguments must be an object");
    return value;
}
function requiredString(input, field) {
    const value = input[field];
    if (typeof value !== "string")
        throw new Error(`${field} is required`);
    return boundedText(value, field, 16_000);
}
function optionalInteger(input, field, fallback) {
    const value = input[field];
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value))
        throw new Error(`${field} must be an integer`);
    return Number(value);
}
function capabilityValue(value) {
    if (value !== "repository_read" && value !== "verification" && value !== "git_inspect") {
        throw new Error("capability must be repository_read, verification, or git_inspect");
    }
    return value;
}
function statePath(config, taskId) {
    return path.join(taskDirectory(config, taskId), "progressive-tools.json");
}
function auditPath(config, taskId) {
    return path.join(taskDirectory(config, taskId), "progressive-tools-audit.ndjson");
}
async function readState(config, taskId) {
    const target = statePath(config, taskId);
    if (!await pathExists(target)) {
        return { schemaVersion: 1, taskId, enabled: [], updatedAt: nowIso() };
    }
    const raw = JSON.parse(await readFile(target, "utf8"));
    const enabled = Array.isArray(raw.enabled)
        ? raw.enabled.filter((item) => item === "repository_read" || item === "verification" || item === "git_inspect")
        : [];
    return { schemaVersion: 1, taskId, enabled: [...new Set(enabled)], updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso() };
}
async function appendAudit(config, event) {
    await ensureDir(taskDirectory(config, event.taskId));
    await appendFile(auditPath(config, event.taskId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}
function assertUsableTask(task) {
    if (task.executor !== "harness" && task.effectiveExecutor !== "harness")
        throw new Error("progressive tools are available only to Harness leaves");
    if (task.harnessMode !== "minimal")
        throw new Error("progressive tools are available only in Harness minimal mode");
    if (task.status !== "queued" && task.status !== "running")
        throw new Error(`task is not active: ${task.status}`);
}
async function canonicalWorktree(task) {
    return await realpath(task.worktreePath);
}
async function resolveReadablePath(task, input) {
    const relative = normalizeRepoRelative(input);
    const worktree = await canonicalWorktree(task);
    const candidate = path.resolve(worktree, relative);
    if (!isWithin(candidate, worktree))
        throw new Error(`path escapes worktree: ${input}`);
    const info = await lstat(candidate);
    if (info.isSymbolicLink())
        throw new Error(`symbolic links are not readable through this tool: ${relative}`);
    if (!info.isFile())
        throw new Error(`path is not a regular file: ${relative}`);
    const canonical = await realpath(candidate);
    if (!isWithin(canonical, worktree))
        throw new Error(`resolved path escapes worktree: ${relative}`);
    return { relative, absolute: canonical };
}
async function commandResult(command, args, task, timeoutMs = 120_000, maxCaptureChars = 200_000) {
    const result = await runProcess(command, args, {
        cwd: task.worktreePath,
        timeoutMs,
        maxCaptureChars,
        killProcessGroup: true,
    });
    return {
        code: result.code,
        timedOut: result.timedOut,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
    };
}
async function auditToolCall(config, task, capability, tool, action) {
    try {
        const result = await action();
        await appendAudit(config, {
            schemaVersion: 1,
            at: nowIso(),
            taskId: task.id,
            planId: task.planId,
            leafId: task.leafId,
            kind: "tool_call",
            capability,
            tool,
            result: "completed",
        });
        return result;
    }
    catch (error) {
        await appendAudit(config, {
            schemaVersion: 1,
            at: nowIso(),
            taskId: task.id,
            planId: task.planId,
            leafId: task.leafId,
            kind: "tool_call",
            capability,
            tool,
            result: "failed",
            reason: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        });
        throw error;
    }
}
async function buildTools(config, task, enabled) {
    const base = [
        {
            name: "capability_catalog",
            description: "List the task-authorized progressive capabilities. Only enable a capability when the current leaf actually requires it.",
            inputSchema: objectSchema({}),
            invoke: async () => ({
                taskId: task.id,
                harnessMode: task.harnessMode,
                authorized: task.toolCapabilities.map((capability) => ({
                    capability,
                    description: CAPABILITIES[capability].description,
                    tools: CAPABILITIES[capability].tools,
                    enabled: enabled.includes(capability),
                })),
                rule: "Capabilities absent from this contract cannot be enabled. Tool schemas appear only after explicit enablement.",
            }),
        },
        {
            name: "capability_enable",
            description: "Enable one capability already authorized by the frozen leaf contract. This changes the MCP tool list and is audited.",
            inputSchema: objectSchema({ capability: { type: "string", enum: ["repository_read", "verification", "git_inspect"] }, reason: stringSchema(2000) }, ["capability", "reason"]),
            invoke: async (input) => {
                const capability = capabilityValue(input.capability);
                const reason = requiredString(input, "reason");
                return await withNamedLock(config, `progressive-tools:${task.id}`, 30_000, async () => {
                    const currentTask = await loadTask(config, task.id);
                    assertUsableTask(currentTask);
                    const state = await readState(config, task.id);
                    if (!currentTask.toolCapabilities.includes(capability)) {
                        await appendAudit(config, {
                            schemaVersion: 1,
                            at: nowIso(),
                            taskId: currentTask.id,
                            planId: currentTask.planId,
                            leafId: currentTask.leafId,
                            kind: "capability_enable",
                            capability,
                            result: "denied",
                            reason,
                        });
                        throw new Error(`capability is not authorized by the leaf contract: ${capability}`);
                    }
                    const already = state.enabled.includes(capability);
                    const next = {
                        schemaVersion: 1,
                        taskId: currentTask.id,
                        enabled: already ? state.enabled : [...state.enabled, capability],
                        updatedAt: nowIso(),
                    };
                    await atomicWriteJson(statePath(config, currentTask.id), next);
                    await appendAudit(config, {
                        schemaVersion: 1,
                        at: next.updatedAt,
                        taskId: currentTask.id,
                        planId: currentTask.planId,
                        leafId: currentTask.leafId,
                        kind: "capability_enable",
                        capability,
                        result: already ? "already_enabled" : "enabled",
                        reason,
                    });
                    return { capability, enabled: true, changed: !already, tools: CAPABILITIES[capability].tools };
                });
            },
        },
    ];
    if (enabled.includes("repository_read")) {
        base.push({
            name: "repo_read_file",
            description: "Read a bounded line range from a regular file inside the isolated worktree.",
            inputSchema: objectSchema({ filePath: stringSchema(4096), startLine: integerSchema(1, 10_000_000, 1), endLine: integerSchema(1, 10_000_000, 400) }, ["filePath"]),
            invoke: async (input) => await auditToolCall(config, task, "repository_read", "repo_read_file", async () => {
                const target = await resolveReadablePath(task, requiredString(input, "filePath"));
                const start = optionalInteger(input, "startLine", 1);
                const end = optionalInteger(input, "endLine", Math.min(start + 399, 10_000_000));
                if (end < start || end - start > 1999)
                    throw new Error("line range must be ordered and contain at most 2000 lines");
                const info = await lstat(target.absolute);
                if (info.size > 5_000_000)
                    throw new Error("file exceeds the 5 MB progressive-read limit");
                const text = await readFile(target.absolute, "utf8");
                if (text.includes("\0"))
                    throw new Error("binary/NUL file is not supported");
                const lines = text.split(/\r?\n/);
                return {
                    path: target.relative,
                    startLine: start,
                    endLine: Math.min(end, lines.length),
                    totalLines: lines.length,
                    text: lines.slice(start - 1, end).join("\n"),
                };
            }),
        });
        base.push({
            name: "repo_search",
            description: "Search tracked repository text with git grep. Output is bounded and read-only.",
            inputSchema: objectSchema({ pattern: stringSchema(1000), paths: { type: "array", items: stringSchema(4096), maxItems: 20 } }, ["pattern"]),
            invoke: async (input) => await auditToolCall(config, task, "repository_read", "repo_search", async () => {
                const pattern = requiredString(input, "pattern");
                const pathValues = input.paths === undefined ? [] : input.paths;
                if (!Array.isArray(pathValues) || !pathValues.every((item) => typeof item === "string"))
                    throw new Error("paths must be an array of strings");
                const paths = pathValues.map((item) => normalizeRepoRelative(item));
                const result = await commandResult("git", ["grep", "-n", "--no-color", "-I", "-e", pattern, "--", ...(paths.length > 0 ? paths : ["."])], task, 60_000, 200_000);
                const code = result.code;
                if (code !== 0 && code !== 1)
                    throw new Error(`git grep failed: ${String(result.stderr)}`);
                return result;
            }),
        });
    }
    if (enabled.includes("verification")) {
        base.push({
            name: "run_verification",
            description: "Run one exact verification command frozen by Codex, selected by zero-based index. No arbitrary command text is accepted.",
            inputSchema: objectSchema({ commandIndex: integerSchema(0, 99), timeoutSeconds: integerSchema(1, 7200, 1800) }, ["commandIndex"]),
            invoke: async (input) => await auditToolCall(config, task, "verification", "run_verification", async () => {
                const index = optionalInteger(input, "commandIndex", -1);
                const command = task.verificationCommands[index];
                if (command === undefined)
                    throw new Error(`verification command index out of range: ${index}`);
                const timeoutSeconds = optionalInteger(input, "timeoutSeconds", 1800);
                return { commandIndex: index, command, ...(await commandResult("bash", ["-lc", command], task, timeoutSeconds * 1000, 500_000)) };
            }),
        });
    }
    if (enabled.includes("git_inspect")) {
        base.push({
            name: "git_status",
            description: "Read porcelain Git status and branch identity for the isolated worktree.",
            inputSchema: objectSchema({}),
            invoke: async () => await auditToolCall(config, task, "git_inspect", "git_status", async () => await commandResult("git", ["status", "--short", "--branch"], task, 60_000, 100_000)),
        });
        base.push({
            name: "git_diff",
            description: "Read a bounded working-tree diff. An optional path must stay inside the worktree.",
            inputSchema: objectSchema({ filePath: stringSchema(4096), statOnly: { type: "boolean", default: false } }),
            invoke: async (input) => await auditToolCall(config, task, "git_inspect", "git_diff", async () => {
                const selectedPath = typeof input.filePath === "string" ? normalizeRepoRelative(input.filePath) : undefined;
                const args = ["diff", "--no-ext-diff", "--no-color"];
                if (input.statOnly === true)
                    args.push("--stat");
                args.push("--");
                if (selectedPath)
                    args.push(selectedPath);
                return await commandResult("git", args, task, 60_000, 500_000);
            }),
        });
    }
    return base;
}
function send(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
function errorResponse(id, code, message) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
async function main() {
    const config = await loadConfig();
    const taskId = safeTaskId(process.env.CODEX_HARNESS_TASK_ID);
    const task = await loadTask(config, taskId);
    assertUsableTask(task);
    let buffer = "";
    let chain = Promise.resolve();
    const handle = async (request) => {
        if (request.method.startsWith("notifications/") || request.id === undefined)
            return;
        const id = request.id;
        try {
            if (request.method === "initialize") {
                const params = asObject(request.params);
                send({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: "codex-harness-progressive-tools", version: "0.6.4" },
                        instructions: "Start with capability_catalog. Enable only contract-authorized capabilities needed by this leaf. No capability grants write scope.",
                    },
                });
                return;
            }
            if (request.method === "ping") {
                send({ jsonrpc: "2.0", id, result: {} });
                return;
            }
            if (request.method === "resources/list") {
                send({ jsonrpc: "2.0", id, result: { resources: [] } });
                return;
            }
            if (request.method === "prompts/list") {
                send({ jsonrpc: "2.0", id, result: { prompts: [] } });
                return;
            }
            const currentTask = await loadTask(config, taskId);
            assertUsableTask(currentTask);
            const state = await readState(config, taskId);
            const tools = await buildTools(config, currentTask, state.enabled);
            const map = new Map(tools.map((tool) => [tool.name, tool]));
            if (request.method === "tools/list") {
                send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ invoke: _invoke, ...tool }) => tool) } });
                return;
            }
            if (request.method === "tools/call") {
                const params = asObject(request.params);
                const name = requiredString(params, "name");
                const tool = map.get(name);
                if (!tool) {
                    send(errorResponse(id, -32602, `tool is not currently disclosed: ${name}`));
                    return;
                }
                try {
                    const result = await tool.invoke(asObject(params.arguments));
                    send({ jsonrpc: "2.0", id, result: jsonToolResult(result) });
                    if (name === "capability_enable" && result.changed === true) {
                        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
                    }
                }
                catch (error) {
                    send({ jsonrpc: "2.0", id, result: jsonToolResult({ error: error instanceof Error ? error.message : String(error) }, true) });
                }
                return;
            }
            send(errorResponse(id, -32601, `method not found: ${request.method}`));
        }
        catch (error) {
            send(errorResponse(id, -32603, error instanceof Error ? error.message : String(error)));
        }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 8_000_000) {
            process.stderr.write("progressive MCP input buffer exceeded 8000000 characters\n");
            process.exit(1);
        }
        while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0)
                break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line)
                continue;
            chain = chain.then(async () => {
                try {
                    const request = JSON.parse(line);
                    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
                        send(errorResponse(null, -32600, "invalid JSON-RPC request"));
                        return;
                    }
                    await handle(request);
                }
                catch (error) {
                    send(errorResponse(null, -32700, error instanceof Error ? error.message : "parse error"));
                }
            });
        }
    });
    process.stdin.on("end", () => { void chain.finally(() => process.exit(0)); });
    process.stdin.resume();
}
await main().catch((error) => {
    process.stderr.write(`progressive-tools: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=minimal-tools-server.js.map