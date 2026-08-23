import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioMcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #stderr = "";
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-200_000);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let value: JsonRpcResponse;
      try {
        value = JSON.parse(trimmed) as JsonRpcResponse;
      } catch (error) {
        this.failAll(new Error(`MCP server emitted invalid JSON: ${trimmed.slice(0, 1000)}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!Number.isInteger(value.id)) return;
      const pending = this.#pending.get(value.id);
      if (!pending) return;
      this.#pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) {
        pending.reject(new Error(`MCP JSON-RPC error ${value.error.code ?? "unknown"}: ${value.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(value.result);
      }
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code, signal) => {
      if (!this.#closed) {
        this.failAll(new Error(`MCP server exited unexpectedly code=${String(code)} signal=${String(signal)} stderr=${this.#stderr}`));
      }
    });
  }

  static async connect(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<StdioMcpClient> {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const client = new StdioMcpClient(child);
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-harness-local-client", version: "0.6.4" },
    }, timeoutMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return client;
  }

  get stderr(): string { return this.#stderr; }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) throw new Error("MCP client is closed");
    const id = this.#nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs} ms: ${method}; stderr=${this.#stderr}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>, timeoutMs = 120_000): Promise<McpToolResult> {
    return await this.request("tools/call", { name, arguments: argumentsValue }, timeoutMs) as McpToolResult;
  }

  async listTools(): Promise<unknown> {
    return await this.request("tools/list", {}, 30_000);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client closed"));
    }
    this.#pending.clear();
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const force = setTimeout(() => {
        if (!this.child.killed) this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      force.unref();
      this.child.once("close", () => { clearTimeout(force); resolve(); });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function parseToolPayload(result: McpToolResult, allowError = false): Record<string, unknown> {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== "text" || typeof content[0].text !== "string") {
    throw new Error(`unexpected MCP tool result: ${JSON.stringify(result)}`);
  }
  const payload = JSON.parse(content[0].text) as Record<string, unknown>;
  if (result.isError && !allowError) throw new Error(`MCP tool error: ${String(payload.error ?? JSON.stringify(payload))}`);
  return payload;
}
