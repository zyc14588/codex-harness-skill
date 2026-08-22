import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class StdioMcpClient {
    child;
    #nextId = 1;
    #pending = new Map();
    #stderr = "";
    #closed = false;
    constructor(child) {
        this.child = child;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            this.#stderr = (this.#stderr + chunk).slice(-200_000);
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            let value;
            try {
                value = JSON.parse(trimmed);
            }
            catch (error) {
                this.failAll(new Error(`MCP server emitted invalid JSON: ${trimmed.slice(0, 1000)}: ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
            if (!Number.isInteger(value.id))
                return;
            const pending = this.#pending.get(value.id);
            if (!pending)
                return;
            this.#pending.delete(value.id);
            clearTimeout(pending.timer);
            if (value.error) {
                pending.reject(new Error(`MCP JSON-RPC error ${value.error.code ?? "unknown"}: ${value.error.message ?? "unknown error"}`));
            }
            else {
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
    static async connect(command, args, env, timeoutMs = 15_000) {
        const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        const client = new StdioMcpClient(child);
        await client.request("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "codex-harness-local-client", version: "0.6.3" },
        }, timeoutMs);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
        return client;
    }
    get stderr() { return this.#stderr; }
    async request(method, params, timeoutMs = 30_000) {
        if (this.#closed)
            throw new Error("MCP client is closed");
        const id = this.#nextId++;
        const request = { jsonrpc: "2.0", id, method, params };
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`MCP request timed out after ${timeoutMs} ms: ${method}; stderr=${this.#stderr}`));
            }, timeoutMs);
            timer.unref();
            this.#pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
                if (!error)
                    return;
                const pending = this.#pending.get(id);
                if (!pending)
                    return;
                this.#pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(error);
            });
        });
    }
    async callTool(name, argumentsValue, timeoutMs = 120_000) {
        return await this.request("tools/call", { name, arguments: argumentsValue }, timeoutMs);
    }
    async listTools() {
        return await this.request("tools/list", {}, 30_000);
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("MCP client closed"));
        }
        this.#pending.clear();
        if (!this.child.killed)
            this.child.kill("SIGTERM");
        await new Promise((resolve) => {
            if (this.child.exitCode !== null || this.child.signalCode !== null)
                return resolve();
            const force = setTimeout(() => {
                if (!this.child.killed)
                    this.child.kill("SIGKILL");
                resolve();
            }, 2_000);
            force.unref();
            this.child.once("close", () => { clearTimeout(force); resolve(); });
        });
    }
    failAll(error) {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }
}
export function parseToolPayload(result, allowError = false) {
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== "text" || typeof content[0].text !== "string") {
        throw new Error(`unexpected MCP tool result: ${JSON.stringify(result)}`);
    }
    const payload = JSON.parse(content[0].text);
    if (result.isError && !allowError)
        throw new Error(`MCP tool error: ${String(payload.error ?? JSON.stringify(payload))}`);
    return payload;
}
//# sourceMappingURL=stdio-client.js.map