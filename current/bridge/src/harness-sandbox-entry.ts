import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

interface LaunchSpec {
  schemaVersion: 1;
  command: string;
  args: string[];
  cwd: string;
}

interface CapabilityInput {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  providerToken: string;
  adapterToken: string;
  toolToken: string;
}

const MAX_RELAY_BODY_BYTES = 16_000_000;

function fail(response: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${JSON.stringify({ error: message })}\n`);
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
}

function jsonContentType(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  if (Array.isArray(raw) || typeof raw !== "string") return false;
  return raw.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

function allowedRelayPath(rawUrl: string, capability: CapabilityInput): boolean {
  let url: URL;
  try { url = new URL(rawUrl, "http://127.0.0.1"); }
  catch { return false; }
  if (url.search || url.hash) return false;
  const task = encodeURIComponent(capability.taskId);
  const attempt = encodeURIComponent(capability.attemptId);
  if (url.pathname === `/provider/${task}/${attempt}/chat/completions`) return true;
  if (url.pathname === `/tool-exec/${task}/${attempt}`) return true;
  return ["publish-runner-snapshot", "arm-primary-mutation", "record-adapter-request"]
    .some((operation) => url.pathname === `/adapter-state/${task}/${attempt}/${operation}`);
}

function relay(socketPath: string, capability: CapabilityInput, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "POST") return fail(response, 405, "isolated relay permits POST only");
  if (!jsonContentType(request)) return fail(response, 415, "isolated relay requires application/json");
  if (!allowedRelayPath(request.url ?? "", capability)) return fail(response, 404, "isolated relay path is not allowed");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RELAY_BODY_BYTES) return fail(response, 413, "isolated relay body is too large");
  const upstream = http.request({
    socketPath,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: "codex-harness-internal" },
  }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.once("aborted", () => response.destroy(new Error("internal monitor response aborted")));
    incoming.pipe(response);
  });
  const abortUpstream = (reason: string): void => {
    if (!upstream.destroyed) upstream.destroy(new Error(reason));
  };
  let observed = 0;
  request.on("data", (chunk: Buffer) => {
    observed += chunk.length;
    if (observed > MAX_RELAY_BODY_BYTES) {
      request.destroy(new Error("isolated relay body is too large"));
      abortUpstream("isolated relay body is too large");
    }
  });
  request.once("aborted", () => abortUpstream("isolated relay client aborted"));
  request.once("close", () => {
    if (request.aborted || !request.complete) abortUpstream("isolated relay client request closed early");
  });
  response.once("close", () => {
    if (!response.writableEnded) abortUpstream("isolated relay client response closed early");
  });
  upstream.once("error", (error) => {
    if (!response.headersSent) fail(response, 502, `internal monitor relay failed: ${error.message}`);
    else response.destroy(error);
  });
  request.pipe(upstream);
}

async function readCapabilityInput(): Promise<CapabilityInput> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 2_048) throw new Error("capability input exceeds 2048 bytes");
    chunks.push(chunk);
  }
  process.stdin.destroy();
  let parsed: Partial<CapabilityInput>;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<CapabilityInput>; }
  catch { throw new Error("capability input is not valid JSON"); }
  if (parsed.schemaVersion !== 1
    || typeof parsed.taskId !== "string" || !/^[A-Za-z0-9._-]{1,160}$/u.test(parsed.taskId)
    || typeof parsed.attemptId !== "string" || !/^[A-Za-z0-9._-]{1,160}$/u.test(parsed.attemptId)
    || typeof parsed.providerToken !== "string" || !/^[a-f0-9]{48}$/u.test(parsed.providerToken)
    || typeof parsed.adapterToken !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.adapterToken)
    || typeof parsed.toolToken !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.toolToken)
    || new Set([parsed.providerToken, parsed.adapterToken, parsed.toolToken]).size !== 3) {
    throw new Error("capability input is invalid");
  }
  return parsed as CapabilityInput;
}

async function launchSpec(target: string, sandboxRoot: string): Promise<LaunchSpec> {
  const canonicalRoot = await realpath(sandboxRoot);
  const canonical = await realpath(target);
  const relative = path.relative(canonicalRoot, canonical);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("launch spec resolves outside sandbox root");
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 128_000) {
    throw new Error("launch spec must be a 0600 regular file no larger than 128000 bytes");
  }
  const parsed = JSON.parse(await readFile(canonical, "utf8")) as Partial<LaunchSpec>;
  if (parsed.schemaVersion !== 1 || typeof parsed.command !== "string" || !path.isAbsolute(parsed.command)
    || typeof parsed.cwd !== "string" || !path.isAbsolute(parsed.cwd)
    || !Array.isArray(parsed.args) || parsed.args.length > 128
    || !parsed.args.every((item) => typeof item === "string" && !item.includes("\0") && item.length <= 16_000)) {
    throw new Error("launch spec is invalid");
  }
  return parsed as LaunchSpec;
}

async function main(): Promise<void> {
  const socketPath = process.env.CODEX_HARNESS_MONITOR_SOCKET;
  const sandboxRoot = process.env.CODEX_HARNESS_SANDBOX_ROOT;
  const launchPath = process.env.CODEX_HARNESS_LAUNCH_SPEC;
  const relayPort = Number(process.env.CODEX_HARNESS_RELAY_PORT);
  if (!socketPath || !sandboxRoot || !launchPath || !Number.isInteger(relayPort) || relayPort < 1_024 || relayPort > 65_535) {
    throw new Error("isolated Harness entry configuration is incomplete");
  }
  const spec = await launchSpec(launchPath, sandboxRoot);
  const capability = await readCapabilityInput();
  if (process.env.CODEX_HARNESS_TASK_ID !== capability.taskId
    || process.env.CODEX_HARNESS_ATTEMPT_ID !== capability.attemptId) {
    throw new Error("capability route identity does not match the frozen Harness attempt");
  }
  const server = http.createServer((request, response) => relay(socketPath, capability, request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(relayPort, "127.0.0.1", resolve);
  });

  let child: ChildProcess | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    try { child?.kill(signal); } catch { /* namespace teardown remains authoritative */ }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DEEPSEEK_API_KEY: capability.providerToken,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${relayPort}/provider/${encodeURIComponent(capability.taskId)}/${encodeURIComponent(capability.attemptId)}`,
      CODEX_HARNESS_ADAPTER_STATE_URL: `http://127.0.0.1:${relayPort}/adapter-state/${encodeURIComponent(capability.taskId)}/${encodeURIComponent(capability.attemptId)}`,
      CODEX_HARNESS_ADAPTER_TOKEN: capability.adapterToken,
      CODEX_HARNESS_TOOL_URL: `http://127.0.0.1:${relayPort}/tool-exec/${encodeURIComponent(capability.taskId)}/${encodeURIComponent(capability.attemptId)}`,
      CODEX_HARNESS_TOOL_TOKEN: capability.toolToken,
    };
    delete childEnv.CODEX_HARNESS_MONITOR_SOCKET;
    delete childEnv.CODEX_HARNESS_RELAY_PORT;
    delete childEnv.CODEX_HARNESS_LAUNCH_SPEC;
    delete childEnv.DEEPSEEK_SEARCH_BASE_URL;
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) process.kill(process.pid, result.signal);
    process.exitCode = result.code ?? 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`harness-sandbox-entry: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
