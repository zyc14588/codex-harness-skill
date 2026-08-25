import { type ChildProcessWithoutNullStreams } from "node:child_process";
export interface McpToolResult {
    content?: Array<{
        type?: string;
        text?: string;
    }>;
    isError?: boolean;
}
export declare class StdioMcpClient {
    #private;
    readonly child: ChildProcessWithoutNullStreams;
    initializeResult?: unknown;
    private constructor();
    static connect(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<StdioMcpClient>;
    get stderr(): string;
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
    callTool(name: string, argumentsValue: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
    listTools(): Promise<unknown>;
    close(): Promise<void>;
    private failAll;
}
export declare function parseToolPayload(result: McpToolResult, allowError?: boolean): Record<string, unknown>;
