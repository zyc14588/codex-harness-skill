import {
  cancelTask,
  cleanupTask,
  collectTask,
  commitTask,
  controllerPlanStatus,
  controllerSplitAdvice,
  controllerSplitMemory,
  createControllerPlan,
  doctor,
  finalizeControllerPlan,
  jsonToolResult,
  listControllerPlans,
  listRecentTasks,
  monitorSnapshot,
  monitorStatus,
  monitorStop,
  readChangedFile,
  repairTask,
  reviewTask,
  startTask,
  taskStatus,
  verifyTask,
} from "./service.js";
import type { CreateControllerPlanInput, SplitAdviceCandidateInput } from "./service.js";
import type { ReviewDecision } from "./types.js";

const MCP_IMPLEMENTATION_COMMIT = process.env.CODEX_HARNESS_IMPLEMENTATION_COMMIT?.trim();
if (MCP_IMPLEMENTATION_COMMIT && !/^[0-9a-f]{40,64}$/u.test(MCP_IMPLEMENTATION_COMMIT)) {
  throw new Error("CODEX_HARNESS_IMPLEMENTATION_COMMIT must be a full Git object id");
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  invoke: (input: Record<string, unknown>) => Promise<unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const stringSchema = (maxLength = 4096): Record<string, unknown> => ({ type: "string", minLength: 1, maxLength });
const booleanSchema = (defaultValue?: boolean): Record<string, unknown> => defaultValue === undefined ? { type: "boolean" } : { type: "boolean", default: defaultValue };
const integerSchema = (minimum: number, maximum: number, defaultValue?: number): Record<string, unknown> => ({
  type: "integer", minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }),
});

function args(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("tool arguments must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalInteger(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return Number(value);
}

function stringArray(input: Record<string, unknown>, field: string, fallback?: string[]): string[] {
  const value = input[field];
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be an array of strings`);
  return value;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const controlledWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const leafSchema = objectSchema({
  id: stringSchema(200),
  objective: stringSchema(6000),
  executor: { type: "string", enum: ["auto", "harness", "llama_cpp"], default: "auto" },
  complexity: { type: "string", enum: ["trivial", "small", "medium", "large"] },
  mode: { type: "string", enum: ["implementation", "test", "review", "analysis"], default: "implementation" },
  harnessMode: { type: "string", enum: ["minimal"], default: "minimal", description: "0.6.6 disables Harness standard mode." },
  parallelGroup: stringSchema(200),
  dependsOn: { type: "array", items: stringSchema(200), maxItems: 32, default: [] },
  toolCapabilities: { type: "array", items: { type: "string", enum: ["repository_read", "verification", "git_inspect"] }, maxItems: 3 },
  taskFamily: stringSchema(500),
  splitRationale: stringSchema(8000),
  memoryOverrideReason: stringSchema(4000),
  harnessWritePaths: { type: "array", items: stringSchema(), minItems: 1, maxItems: 30 },
  codexWritePaths: { type: "array", items: stringSchema(), maxItems: 30, default: [] },
  acceptanceCriteria: { type: "array", items: stringSchema(8000), minItems: 1, maxItems: 20 },
  contextFiles: { type: "array", items: stringSchema(), maxItems: 40, default: [] },
  verificationCommands: { type: "array", items: stringSchema(16000), minItems: 1, maxItems: 100 },
  runtimeSeconds: integerSchema(60, 14400),
  model: stringSchema(512),
  budget: objectSchema({
    maxApiCalls: integerSchema(1, 1_000_000, undefined),
    maxInputTokens: { ...integerSchema(1, 10_000_000_000), description: "Hard cumulative input-token gate." },
    maxOutputTokens: { ...integerSchema(1, 10_000_000_000), description: "Hard cumulative output-token gate." },
    maxCostCny: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000, description: "Reference/alert threshold only; never an execution gate in R6." },
    maxCostUsd: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000, description: "Hidden compatibility/reference value; never an execution gate in R6." },
  }),
}, ["id", "objective", "complexity", "harnessWritePaths", "acceptanceCriteria", "verificationCommands"]);

const tools: ToolDefinition[] = [
  {
    name: "bridge_doctor",
    description: "Validate bridge configuration, live controller limits, monitor health, Harness provenance/profile, and optional llama.cpp health.",
    annotations: readOnly,
    inputSchema: objectSchema({ probeHarness: booleanSchema(false) }),
    invoke: async (input) => await doctor(input.probeHarness === true),
  },
  {
    name: "controller_plan_create",
    description: "Freeze a clean base commit, dependency graph, parallel groups, adaptive split-memory decision, mutually exclusive write leases, and input/output token gates before execution. Minimal Harness is preferred; only Pro Harness leaves may be large.",
    annotations: controlledWrite,
    inputSchema: objectSchema({
      repoRoot: stringSchema(),
      baseRef: stringSchema(512),
      planId: stringSchema(200),
      userRequestedLlamaCpp: booleanSchema(false),
      leaves: { type: "array", items: leafSchema, minItems: 1, maxItems: 32 },
    }, ["repoRoot", "leaves"]),
    invoke: async (input) => await createControllerPlan(input as unknown as CreateControllerPlanInput),
  },
  {
    name: "controller_split_advice",
    description: "Read adaptive split-memory recommendations before creating a plan. Returns recommended leaf scale, complexity, and input/output token gates for each task family/model/mode candidate.",
    annotations: readOnly,
    inputSchema: objectSchema({
      repoRoot: stringSchema(),
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: objectSchema({
          id: stringSchema(200),
          taskFamily: stringSchema(500),
          executor: { type: "string", enum: ["auto", "harness", "llama_cpp"], default: "harness" },
          model: stringSchema(512),
          harnessMode: { type: "string", enum: ["minimal"], default: "minimal" },
          mode: { type: "string", enum: ["implementation", "test", "review", "analysis"], default: "implementation" },
          complexity: { type: "string", enum: ["trivial", "small", "medium", "large"] },
          proComplex: booleanSchema(false),
        }, ["id", "taskFamily", "complexity"]),
      },
    }, ["repoRoot", "candidates"]),
    invoke: async (input) => await controllerSplitAdvice(
      requiredString(input, "repoRoot"),
      input.candidates as SplitAdviceCandidateInput[],
    ),
  },
  {
    name: "controller_split_memory",
    description: "Inspect persisted decomposition/outcome memory and current adaptive policy. Memory stores derived metrics and anomalies, not task prompt bodies.",
    annotations: readOnly,
    inputSchema: objectSchema({ repoRoot: stringSchema() }),
    invoke: async (input) => await controllerSplitMemory(optionalString(input, "repoRoot")),
  },
  {
    name: "controller_plan_status",
    description: "Read one controller plan, its immutable contract, and current leaf/task states.",
    annotations: readOnly,
    inputSchema: objectSchema({ planId: stringSchema(200) }, ["planId"]),
    invoke: async (input) => await controllerPlanStatus(requiredString(input, "planId")),
  },
  {
    name: "controller_plan_list",
    description: "List recent controller plans and leaf states.",
    annotations: readOnly,
    inputSchema: objectSchema({ limit: integerSchema(1, 50, 20) }),
    invoke: async (input) => await listControllerPlans(optionalInteger(input, "limit") ?? 20),
  },
  {
    name: "controller_launch_leaf",
    description: "Launch one dependency-ready leaf in an isolated worktree. Multiple disjoint minimal Harness leaves may run concurrently. Only cumulative input/output tokens gate model use; calls and cost remain reference telemetry.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: objectSchema({ planId: stringSchema(200), leafId: stringSchema(200), taskId: stringSchema(200) }, ["planId", "leafId"]),
    invoke: async (input) => {
      const taskId = optionalString(input, "taskId");
      return await startTask({
        planId: requiredString(input, "planId"),
        leafId: requiredString(input, "leafId"),
        ...(taskId === undefined ? {} : { taskId }),
      });
    },
  },
  {
    name: "harness_start",
    description: "Compatibility alias for controller_launch_leaf. Free-form objectives are intentionally unsupported.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: objectSchema({ planId: stringSchema(200), leafId: stringSchema(200), taskId: stringSchema(200) }, ["planId", "leafId"]),
    invoke: async (input) => {
      const taskId = optionalString(input, "taskId");
      return await startTask({
        planId: requiredString(input, "planId"),
        leafId: requiredString(input, "leafId"),
        ...(taskId === undefined ? {} : { taskId }),
      });
    },
  },
  {
    name: "harness_status",
    description: "Read non-blocking worker status, routing/fallback attempts, logs, cumulative token/CNY cost usage, and the current Web-controlled budget state.",
    annotations: readOnly,
    inputSchema: objectSchema({ taskId: stringSchema(200) }, ["taskId"]),
    invoke: async (input) => await taskStatus(requiredString(input, "taskId")),
  },
  {
    name: "harness_collect",
    description: "Collect terminal changed paths, scope evidence, diff statistics, and an optional bounded patch for Codex review.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ taskId: stringSchema(200), includePatch: booleanSchema(false), maxPatchChars: integerSchema(0, 100_000, 60_000) }, ["taskId"]),
    invoke: async (input) => await collectTask(requiredString(input, "taskId"), input.includePatch === true, optionalInteger(input, "maxPatchChars") ?? 60_000),
  },
  {
    name: "harness_read_changed_file",
    description: "Read one UTF-8 byte page from a changed text file and persist a fingerprint-bound receipt. Follow nextOffsetBytes until receipt.complete=true for every changed path before approval/revise.",
    annotations: readOnly,
    inputSchema: objectSchema({
      taskId: stringSchema(200),
      filePath: stringSchema(),
      offsetBytes: integerSchema(0, 5_000_000, 0),
      maxBytes: integerSchema(256, 49_152, 49_152),
    }, ["taskId", "filePath"]),
    invoke: async (input) => await readChangedFile(
      requiredString(input, "taskId"),
      requiredString(input, "filePath"),
      optionalInteger(input, "offsetBytes") ?? 0,
      optionalInteger(input, "maxBytes") ?? 49_152,
    ),
  },
  {
    name: "controller_review_task",
    description: "Record Codex review of the exact complete change set and its immutable fingerprint.",
    annotations: controlledWrite,
    inputSchema: objectSchema({
      taskId: stringSchema(200),
      decision: { type: "string", enum: ["approved", "revise", "rejected"] },
      reviewedPaths: { type: "array", items: stringSchema(), maxItems: 500 },
      notes: { type: "string", maxLength: 32000, default: "" },
    }, ["taskId", "decision", "reviewedPaths"]),
    invoke: async (input) => await reviewTask(
      requiredString(input, "taskId"),
      requiredString(input, "decision") as ReviewDecision,
      stringArray(input, "reviewedPaths"),
      typeof input.notes === "string" ? input.notes : "",
    ),
  },
  {
    name: "harness_repair",
    description: "Launch one bounded repair after decision=revise. Repair shares the original cumulative budget.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: objectSchema({ taskId: stringSchema(200), feedback: stringSchema(32000), runtimeSeconds: integerSchema(60, 14400) }, ["taskId", "feedback"]),
    invoke: async (input) => await repairTask(requiredString(input, "taskId"), requiredString(input, "feedback"), optionalInteger(input, "runtimeSeconds")),
  },
  {
    name: "harness_verify",
    description: "Run only controller-frozen verification commands after approved review and reject any diff drift.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: objectSchema({
      taskId: stringSchema(200),
      commands: { type: "array", items: stringSchema(16000), maxItems: 100 },
      timeoutSeconds: integerSchema(1, 7200, 1800),
    }, ["taskId"]),
    invoke: async (input) => await verifyTask(
      requiredString(input, "taskId"),
      input.commands === undefined ? undefined : stringArray(input, "commands"),
      optionalInteger(input, "timeoutSeconds") ?? 1800,
    ),
  },
  {
    name: "harness_commit",
    description: "Create a local branch commit only when current, reviewed, and verified fingerprints match. Never merge or push.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: objectSchema({ taskId: stringSchema(200), message: { type: "string", maxLength: 4000 } }, ["taskId"]),
    invoke: async (input) => await commitTask(requiredString(input, "taskId"), optionalString(input, "message")),
  },
  {
    name: "controller_finalize_plan",
    description: "Finalize only after every leaf is reviewed, verified, accepted, and Codex supplies integration evidence.",
    annotations: controlledWrite,
    inputSchema: objectSchema({ planId: stringSchema(200), integrationEvidence: stringSchema(32000) }, ["planId", "integrationEvidence"]),
    invoke: async (input) => await finalizeControllerPlan(requiredString(input, "planId"), requiredString(input, "integrationEvidence")),
  },
  {
    name: "harness_cancel",
    description: "Cancel a queued or running worker and its process group.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ taskId: stringSchema(200) }, ["taskId"]),
    invoke: async (input) => await cancelTask(requiredString(input, "taskId")),
  },
  {
    name: "harness_cleanup",
    description: "Remove a terminal worktree and optionally its branch while retaining logs, usage, review, and verification evidence.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({ taskId: stringSchema(200), force: booleanSchema(false), deleteBranch: booleanSchema(false) }, ["taskId"]),
    invoke: async (input) => await cleanupTask(requiredString(input, "taskId"), input.force === true, input.deleteBranch === true),
  },
  {
    name: "harness_list",
    description: "List recent Harness and llama.cpp worker tasks.",
    annotations: readOnly,
    inputSchema: objectSchema({ limit: integerSchema(1, 50, 20) }),
    invoke: async (input) => await listRecentTasks(optionalInteger(input, "limit") ?? 20),
  },
  {
    name: "harness_monitor_status",
    description: "Read local monitor health and dashboard URL.",
    annotations: readOnly,
    inputSchema: objectSchema({}),
    invoke: async () => await monitorStatus(),
  },
  {
    name: "harness_monitor_snapshot",
    description: "Read task, routing, token, cache, latency, live CNY budget, reconciliation, and local-model control state.",
    annotations: readOnly,
    inputSchema: objectSchema({ limit: integerSchema(1, 500, 100) }),
    invoke: async (input) => await monitorSnapshot(optionalInteger(input, "limit") ?? 100),
  },
  {
    name: "harness_monitor_stop",
    description: "Stop the local loopback monitor. Auto-started tasks can restart it.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: objectSchema({}),
    invoke: async () => await monitorStop(),
  },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorResponse(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id;
  if (request.method.startsWith("notifications/")) return;
  if (id === undefined) return;
  try {
    if (request.method === "initialize") {
      const params = args(request.params);
      const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "codex-harness-bridge",
            version: "0.6.6",
            ...(MCP_IMPLEMENTATION_COMMIT ? { implementationCommit: MCP_IMPLEMENTATION_COMMIT } : {}),
          },
          instructions: "Codex is the controller. Query split memory before decomposition, prefer minimal Harness, launch dependency-ready disjoint leaves in parallel, and review every changed file. Input/output token totals are the only model-use gates; calls and costs are reference telemetry.",
        },
      });
      return;
    }
    if (request.method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ invoke: _invoke, ...tool }) => tool) } });
      return;
    }
    if (request.method === "resources/list") { send({ jsonrpc: "2.0", id, result: { resources: [] } }); return; }
    if (request.method === "prompts/list") { send({ jsonrpc: "2.0", id, result: { prompts: [] } }); return; }
    if (request.method === "tools/call") {
      const params = args(request.params);
      const name = requiredString(params, "name");
      const tool = toolMap.get(name);
      if (!tool) { send(errorResponse(id, -32602, `unknown tool: ${name}`)); return; }
      try {
        const result = await tool.invoke(args(params.arguments));
        send({ jsonrpc: "2.0", id, result: jsonToolResult(result) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ jsonrpc: "2.0", id, result: jsonToolResult({ error: message }, true) });
      }
      return;
    }
    send(errorResponse(id, -32601, `method not found: ${request.method}`));
  } catch (error) {
    send(errorResponse(id, -32603, error instanceof Error ? error.message : String(error)));
  }
}

let buffer = "";
let chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (buffer.length > 8_000_000) {
    process.stderr.write("MCP input buffer exceeded 8000000 characters\n");
    process.exit(1);
  }
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    chain = chain.then(async () => {
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          send(errorResponse(null, -32600, "invalid JSON-RPC request"));
          return;
        }
        await handle(request);
      } catch (error) {
        send(errorResponse(null, -32700, "parse error", error instanceof Error ? error.message : String(error)));
      }
    });
  }
});
process.stdin.on("end", () => { void chain.finally(() => process.exit(0)); });
process.stdin.resume();
