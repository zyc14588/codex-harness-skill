import http from "node:http";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
const MAX_RELAY_BODY_BYTES = 16_000_000;
function fail(response, status, message) {
    const body = Buffer.from(`${JSON.stringify({ error: message })}\n`);
    response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
    response.end(body);
}
function allowedRelayPath(url) {
    let pathname;
    try {
        pathname = new URL(url, "http://127.0.0.1").pathname;
    }
    catch {
        return false;
    }
    return /^\/(?:proxy|blocked-search)\/[a-f0-9]{48}(?:\/|$)/.test(pathname)
        || pathname.startsWith("/internal/request-state/");
}
function relay(socketPath, request, response) {
    if (!allowedRelayPath(request.url ?? ""))
        return fail(response, 404, "isolated relay path is not allowed");
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RELAY_BODY_BYTES)
        return fail(response, 413, "isolated relay body is too large");
    const upstream = http.request({
        socketPath,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: "codex-harness-internal" },
    }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
    });
    let observed = 0;
    request.on("data", (chunk) => {
        observed += chunk.length;
        if (observed > MAX_RELAY_BODY_BYTES) {
            request.destroy(new Error("isolated relay body is too large"));
            upstream.destroy();
        }
    });
    request.once("aborted", () => upstream.destroy());
    upstream.once("error", (error) => {
        if (!response.headersSent)
            fail(response, 502, `internal monitor relay failed: ${error.message}`);
        else
            response.destroy(error);
    });
    request.pipe(upstream);
}
async function launchSpec(target, sandboxRoot) {
    const canonicalRoot = await realpath(sandboxRoot);
    const canonical = await realpath(target);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("launch spec resolves outside sandbox root");
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 128_000) {
        throw new Error("launch spec must be a 0600 regular file no larger than 128000 bytes");
    }
    const parsed = JSON.parse(await readFile(canonical, "utf8"));
    if (parsed.schemaVersion !== 1 || typeof parsed.command !== "string" || !path.isAbsolute(parsed.command)
        || typeof parsed.cwd !== "string" || !path.isAbsolute(parsed.cwd)
        || !Array.isArray(parsed.args) || parsed.args.length > 128
        || !parsed.args.every((item) => typeof item === "string" && !item.includes("\0") && item.length <= 16_000)) {
        throw new Error("launch spec is invalid");
    }
    return parsed;
}
async function consumeProxyToken(target, sandboxRoot) {
    const canonicalRoot = await realpath(sandboxRoot);
    const canonical = await realpath(target);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("proxy token file resolves outside sandbox root");
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 256) {
        throw new Error("proxy token must be a bounded 0600 regular file");
    }
    const token = (await readFile(canonical, "utf8")).trim();
    if (!/^[a-f0-9]{48}$/.test(token))
        throw new Error("proxy token format is invalid");
    await rm(canonical, { force: true });
    return token;
}
async function main() {
    const socketPath = process.env.CODEX_HARNESS_MONITOR_SOCKET;
    const sandboxRoot = process.env.CODEX_HARNESS_SANDBOX_ROOT;
    const launchPath = process.env.CODEX_HARNESS_LAUNCH_SPEC;
    const proxyTokenPath = process.env.CODEX_HARNESS_PROXY_TOKEN_FILE;
    const relayPort = Number(process.env.CODEX_HARNESS_RELAY_PORT);
    if (!socketPath || !sandboxRoot || !launchPath || !proxyTokenPath || !Number.isInteger(relayPort) || relayPort < 1_024 || relayPort > 65_535) {
        throw new Error("isolated Harness entry configuration is incomplete");
    }
    const spec = await launchSpec(launchPath, sandboxRoot);
    const proxyToken = await consumeProxyToken(proxyTokenPath, sandboxRoot);
    const server = http.createServer((request, response) => relay(socketPath, request, response));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(relayPort, "127.0.0.1", resolve);
    });
    let child;
    const stop = (signal) => {
        try {
            child?.kill(signal);
        }
        catch { /* namespace teardown remains authoritative */ }
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
    try {
        const childEnv = {
            ...process.env,
            DEEPSEEK_API_KEY: proxyToken,
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${relayPort}/proxy/${proxyToken}`,
            DEEPSEEK_SEARCH_BASE_URL: `http://127.0.0.1:${relayPort}/blocked-search/${proxyToken}`,
            CODEX_HARNESS_INTERNAL_BASE_URL: `http://127.0.0.1:${relayPort}`,
            CODEX_HARNESS_INTERNAL_TOKEN: proxyToken,
        };
        delete childEnv.CODEX_HARNESS_PROXY_TOKEN_FILE;
        child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: childEnv,
            stdio: ["ignore", "inherit", "inherit"],
        });
        const result = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
        });
        if (result.signal)
            process.kill(process.pid, result.signal);
        process.exitCode = result.code ?? 1;
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
    }
}
main().catch((error) => {
    process.stderr.write(`harness-sandbox-entry: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=harness-sandbox-entry.js.map