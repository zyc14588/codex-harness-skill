import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BridgeConfig,
  ControllerConfig,
  LlamaCppConfig,
  LlamaCppMode,
  MonitorConfig,
  PricingEntry,
  HostResourceLimits,
  ResourceProfileId,
  TaskBudget,
} from "./types.js";
import { exactOwnerResourceLimits, OWNER_RESOURCE_LIMITS, RESOURCE_PROFILE_IDS } from "./resource-controls.js";
import { expandHome, isWithin, pathExists, runProcess } from "./util.js";

const DEFAULT_PASS_ENVIRONMENT = [
  "PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];
const ALLOWED_PASS_ENVIRONMENT = new Set(DEFAULT_PASS_ENVIRONMENT);

const LEGACY_MIGRATION_USD_TO_CNY = 7.2;
export const LATEST_HARNESS_FALLBACK_MODEL = "deepseek-v4-flash" as const;
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro" as const;
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash" as const;

export const DEFAULT_BUDGET: TaskBudget = {
  gatePolicy: "input_output_tokens",
  ceilingPolicy: "operator_bounded",
  enforcement: "hard",
  maxApiCalls: 12,
  maxInputTokens: 180_000,
  maxOutputTokens: 24_000,
  maxCostCny: 2.5,
  maxCostUsd: 0.35,
};

export const MAXIMUM_BUDGET: TaskBudget = {
  gatePolicy: "input_output_tokens",
  ceilingPolicy: "operator_bounded",
  enforcement: "hard",
  maxApiCalls: 40,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 128_000,
  maxCostCny: 36,
  maxCostUsd: 5,
};

export const DEFAULT_PRO_COMPLEX_BUDGET: TaskBudget = {
  gatePolicy: "input_output_tokens",
  ceilingPolicy: "unbounded",
  enforcement: "hard",
  maxApiCalls: 120,
  maxInputTokens: 4_000_000,
  maxOutputTokens: 512_000,
  maxCostCny: 360,
  maxCostUsd: 50,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, fallback: number, field: string, min: number, max: number): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || Number(selected) < min || Number(selected) > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return Number(selected);
}

const RESOURCE_LIMIT_KEYS: Array<keyof HostResourceLimits> = [
  "memoryMaxBytes", "cpuQuotaPercent", "tasksMax", "ioWeight", "worktreeMaxBytes",
  "rlimitNoFile", "rlimitNproc", "rlimitFsizeBytes", "commandTimeoutSeconds",
];

function ownerResourceProfiles(value: unknown): Record<ResourceProfileId, HostResourceLimits> {
  const raw = record(value);
  if (Object.keys(raw).length > 0) {
    const actualIds = Object.keys(raw).sort();
    const expectedIds = [...RESOURCE_PROFILE_IDS].sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`harnessIsolation.resourceProfiles must contain the exact Owner-approved ids: ${expectedIds.join(", ")}`);
    }
  }
  const output = {} as Record<ResourceProfileId, HostResourceLimits>;
  for (const id of RESOURCE_PROFILE_IDS) {
    const expected = OWNER_RESOURCE_LIMITS[id];
    const candidateRaw = record(raw[id]);
    if (Object.keys(candidateRaw).length > 0) {
      const actualKeys = Object.keys(candidateRaw).sort();
      const expectedKeys = [...RESOURCE_LIMIT_KEYS].sort();
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`harnessIsolation.resourceProfiles.${id} must contain only the exact numeric limit fields`);
      }
    }
    const candidate = {} as HostResourceLimits;
    for (const key of RESOURCE_LIMIT_KEYS) {
      candidate[key] = integer(candidateRaw[key], expected[key], `harnessIsolation.resourceProfiles.${id}.${key}`, expected[key], expected[key]);
    }
    exactOwnerResourceLimits(id, candidate);
    output[id] = candidate;
  }
  return output;
}

function positiveNumber(value: unknown, fallback: number, field: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return selected;
}

function optionalNonnegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return value;
}

function nullablePositiveNumber(value: unknown, fallback: number | null, field: string): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be null or a positive number`);
  }
  return value;
}

function stringValue(value: unknown, fallback: string, field: string): string {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "string" || !selected.trim() || selected.includes("\0")) {
    throw new Error(`${field} must be a non-empty string without NUL characters`);
  }
  return selected.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${field} must be empty or a non-empty string without NUL characters`);
  }
  return value.trim();
}

function stringArray(value: unknown, fallback: string[], field: string, maxItems = 256): string[] {
  const selected = value === undefined ? fallback : value;
  if (!Array.isArray(selected) || selected.length > maxItems || !selected.every((item) => typeof item === "string" && !item.includes("\0") && item.length <= 16_000)) {
    throw new Error(`${field} must be an array of at most ${maxItems} strings without NUL characters`);
  }
  return selected.map((item) => String(item));
}

function sha256Digest(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${field} is required and must be a lowercase SHA-256 digest`);
    return undefined;
  }
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function normalizeTaskBudget(value: unknown, fallback: TaskBudget, field: string): TaskBudget {
  const raw = record(value);
  const rawUsd = raw.maxCostUsd;
  const rawCny = raw.maxCostCny;
  const maxCostUsd = rawUsd === undefined && typeof rawCny === "number"
    ? positiveNumber(rawCny / LEGACY_MIGRATION_USD_TO_CNY, fallback.maxCostUsd, `${field}.maxCostUsd`)
    : positiveNumber(rawUsd, fallback.maxCostUsd, `${field}.maxCostUsd`);
  const maxCostCny = rawCny === undefined && typeof rawUsd === "number"
    ? positiveNumber(rawUsd * LEGACY_MIGRATION_USD_TO_CNY, fallback.maxCostCny, `${field}.maxCostCny`)
    : positiveNumber(rawCny, fallback.maxCostCny, `${field}.maxCostCny`);
  const enforcementRaw = raw.enforcement ?? fallback.enforcement ?? "hard";
  if (enforcementRaw !== "hard" && enforcementRaw !== "advisory") {
    throw new Error(`${field}.enforcement must be hard or advisory`);
  }
  return {
    gatePolicy: "input_output_tokens",
    ceilingPolicy: raw.ceilingPolicy === "unbounded" || fallback.ceilingPolicy === "unbounded" ? "unbounded" : "operator_bounded",
    enforcement: "hard",
    maxApiCalls: integer(raw.maxApiCalls, fallback.maxApiCalls, `${field}.maxApiCalls`, 1, 1_000_000),
    maxInputTokens: integer(raw.maxInputTokens, fallback.maxInputTokens, `${field}.maxInputTokens`, 1, 10_000_000_000),
    maxOutputTokens: integer(raw.maxOutputTokens, fallback.maxOutputTokens, `${field}.maxOutputTokens`, 1, 10_000_000_000),
    maxCostCny,
    maxCostUsd,
  };
}

export function budgetWithin(value: TaskBudget, maximum: TaskBudget): boolean {
  return value.maxInputTokens <= maximum.maxInputTokens &&
    value.maxOutputTokens <= maximum.maxOutputTokens;
}

function controllerConfig(value: unknown): ControllerConfig {
  const raw = record(value);
  const defaults = { ...normalizeTaskBudget(raw.defaultHarnessBudget, DEFAULT_BUDGET, "controller.defaultHarnessBudget"), enforcement: "hard" as const };
  const maximum = { ...normalizeTaskBudget(raw.maximumHarnessBudget, MAXIMUM_BUDGET, "controller.maximumHarnessBudget"), enforcement: "hard" as const };
  const defaultProComplexBudget = { ...normalizeTaskBudget(raw.defaultProComplexBudget, DEFAULT_PRO_COMPLEX_BUDGET, "controller.defaultProComplexBudget"), enforcement: "hard" as const };
  if (!budgetWithin(defaults, maximum)) throw new Error("controller.defaultHarnessBudget must not exceed controller.maximumHarnessBudget");
  const splitRaw = record(raw.splitMemory);
  const splitMemory = {
    enabled: bool(splitRaw.enabled, true),
    minSamplesForEnforcement: integer(splitRaw.minSamplesForEnforcement, 2, "controller.splitMemory.minSamplesForEnforcement", 1, 100),
    maxEventsPerProfile: integer(splitRaw.maxEventsPerProfile, 64, "controller.splitMemory.maxEventsPerProfile", 4, 10_000),
    minimumLeafScale: positiveNumber(splitRaw.minimumLeafScale, 0.25, "controller.splitMemory.minimumLeafScale"),
    maximumLeafScale: positiveNumber(splitRaw.maximumLeafScale, 1.5, "controller.splitMemory.maximumLeafScale"),
    anomalyPenalty: positiveNumber(splitRaw.anomalyPenalty, 0.35, "controller.splitMemory.anomalyPenalty"),
    successGrowth: positiveNumber(splitRaw.successGrowth, 0.12, "controller.splitMemory.successGrowth"),
    tokenSafetyFactor: positiveNumber(splitRaw.tokenSafetyFactor, 1.35, "controller.splitMemory.tokenSafetyFactor"),
  };
  if (splitMemory.minimumLeafScale > splitMemory.maximumLeafScale) {
    throw new Error("controller.splitMemory.minimumLeafScale must be <= maximumLeafScale");
  }
  if (splitMemory.anomalyPenalty >= 1) throw new Error("controller.splitMemory.anomalyPenalty must be < 1");
  return {
    requirePlan: bool(raw.requirePlan, true),
    maxLeavesPerPlan: integer(raw.maxLeavesPerPlan, 32, "controller.maxLeavesPerPlan", 1, 256),
    maxHarnessWriteLeases: integer(raw.maxHarnessWriteLeases, 30, "controller.maxHarnessWriteLeases", 1, 1_000),
    maxHarnessContextFiles: integer(raw.maxHarnessContextFiles, 40, "controller.maxHarnessContextFiles", 0, 1_000),
    maxHarnessAcceptanceCriteria: integer(raw.maxHarnessAcceptanceCriteria, 20, "controller.maxHarnessAcceptanceCriteria", 1, 1_000),
    maxHarnessObjectiveChars: integer(raw.maxHarnessObjectiveChars, 6_000, "controller.maxHarnessObjectiveChars", 100, 100_000),
    defaultHarnessBudget: defaults,
    maximumHarnessBudget: maximum,
    defaultProComplexBudget,
    maxConcurrentHarnessGlobal: integer(raw.maxConcurrentHarnessGlobal, 4, "controller.maxConcurrentHarnessGlobal", 1, 64),
    maxConcurrentHarnessPerRepo: integer(raw.maxConcurrentHarnessPerRepo, 3, "controller.maxConcurrentHarnessPerRepo", 1, 32),
    preferMinimalHarness: bool(raw.preferMinimalHarness, true),
    splitMemory,
  };
}

function pricingEntry(value: unknown, field: string): PricingEntry {
  const raw = record(value);
  const result: PricingEntry = {};
  const mappings: Array<[keyof PricingEntry, unknown]> = [
    ["inputCacheHitCnyPerMillion", raw.inputCacheHitCnyPerMillion],
    ["inputCacheMissCnyPerMillion", raw.inputCacheMissCnyPerMillion],
    ["outputCnyPerMillion", raw.outputCnyPerMillion],
    ["inputCacheHitUsdPerMillion", raw.inputCacheHitUsdPerMillion],
    ["inputCacheMissUsdPerMillion", raw.inputCacheMissUsdPerMillion],
    ["outputUsdPerMillion", raw.outputUsdPerMillion],
  ];
  for (const [name, candidate] of mappings) {
    const parsed = optionalNonnegativeNumber(candidate, `${field}.${name}`);
    if (parsed !== undefined) result[name] = parsed;
  }
  const cnyComplete = result.inputCacheHitCnyPerMillion !== undefined && result.inputCacheMissCnyPerMillion !== undefined && result.outputCnyPerMillion !== undefined;
  const usdComplete = result.inputCacheHitUsdPerMillion !== undefined && result.inputCacheMissUsdPerMillion !== undefined && result.outputUsdPerMillion !== undefined;
  if (!cnyComplete && !usdComplete) throw new Error(`${field} requires a complete CNY or USD pricing triplet`);
  if ([result.inputCacheHitCnyPerMillion, result.inputCacheMissCnyPerMillion, result.outputCnyPerMillion].some((item) => item !== undefined) && !cnyComplete) {
    throw new Error(`${field} CNY pricing must provide hit, miss, and output rates together`);
  }
  if ([result.inputCacheHitUsdPerMillion, result.inputCacheMissUsdPerMillion, result.outputUsdPerMillion].some((item) => item !== undefined) && !usdComplete) {
    throw new Error(`${field} USD pricing must provide hit, miss, and output rates together`);
  }
  return result;
}

export function assertLoopbackHost(host: string, field: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())) {
    throw new Error(`${field} must be a loopback host (127.0.0.1, localhost, or ::1)`);
  }
}

function normalizeLoopbackUrl(value: unknown, fallback: string, field: string): string {
  const baseUrl = stringValue(value, fallback, field).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error(`${field} must be an absolute URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field} must use http or https`);
  if (url.username || url.password) throw new Error(`${field} must not embed credentials`);
  assertLoopbackHost(url.hostname, `${field} hostname`);
  return baseUrl;
}

function monitorConfig(value: unknown): MonitorConfig {
  const raw = record(value);
  const pricingRaw = record(raw.pricing);
  const pricing: Record<string, PricingEntry> = {};
  for (const [model, candidate] of Object.entries(pricingRaw)) {
    if (!model.trim() || model.includes("\0")) throw new Error("monitor.pricing model names must be non-empty");
    pricing[model] = pricingEntry(candidate, `monitor.pricing.${model}`);
  }
  const host = stringValue(raw.host, "127.0.0.1", "monitor.host");
  assertLoopbackHost(host, "monitor.host");
  const currencyRaw = record(raw.currency);
  const authAuditRaw = record(raw.operatorAuthAudit);
  return {
    enabled: bool(raw.enabled, true),
    host,
    port: integer(raw.port, 43_127, "monitor.port", 1, 65_535),
    autoStart: bool(raw.autoStart, true),
    charsPerEstimatedToken: integer(raw.charsPerEstimatedToken, 4, "monitor.charsPerEstimatedToken", 1, 32),
    pricingAsOf: stringValue(raw.pricingAsOf, "unversioned-local-config", "monitor.pricingAsOf"),
    pricing,
    currency: {
      primary: "CNY",
      showUsd: bool(currencyRaw.showUsd, false),
      usdToCnyRate: nullablePositiveNumber(currencyRaw.usdToCnyRate, null, "monitor.currency.usdToCnyRate"),
      fxAsOf: stringValue(currencyRaw.fxAsOf, "not-configured", "monitor.currency.fxAsOf"),
      fxSource: stringValue(currencyRaw.fxSource, "manual", "monitor.currency.fxSource"),
    },
    operatorAuthAudit: {
      maxBytes: integer(authAuditRaw.maxBytes, 1_048_576, "monitor.operatorAuthAudit.maxBytes", 65_536, 104_857_600),
      maxFiles: integer(authAuditRaw.maxFiles, 4, "monitor.operatorAuthAudit.maxFiles", 1, 32),
      retentionDays: integer(authAuditRaw.retentionDays, 30, "monitor.operatorAuthAudit.retentionDays", 1, 3_650),
      blockedSummaryIntervalSeconds: integer(authAuditRaw.blockedSummaryIntervalSeconds, 60, "monitor.operatorAuthAudit.blockedSummaryIntervalSeconds", 1, 3_600),
    },
  };
}

export function normalizeLlamaConfig(value: unknown, fallback?: LlamaCppConfig): LlamaCppConfig {
  const raw = record(value);
  const defaults: LlamaCppConfig = fallback ?? {
    enabled: false,
    autoRouteSimpleLeaves: true,
    mode: "external_server",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKeyEnv: "LLAMA_CPP_API_KEY",
    model: "local-model",
    serverBinary: "llama-server",
    serverArgs: [],
    serverAutoStart: false,
    serverStartupTimeoutSeconds: 90,
    cliBinary: "llama-cli",
    cliArgs: ["--prompt-file", "{{PROMPT_FILE}}", "-n", "{{MAX_TOKENS}}", "--temp", "0"],
    requestTimeoutSeconds: 600,
    maxFilesPerTask: 3,
    maxContextFiles: 8,
    maxContextBytes: 512_000,
    maxFileBytes: 256_000,
    maxOutputTokens: 16_384,
    fallbackEnabled: true,
    fallbackModel: LATEST_HARNESS_FALLBACK_MODEL,
  };
  const modeRaw = raw.mode ?? defaults.mode;
  if (modeRaw !== "external_server" && modeRaw !== "managed_server" && modeRaw !== "cli") {
    throw new Error("llamaCpp.mode must be external_server, managed_server, or cli");
  }
  const fallbackModel = stringValue(raw.fallbackModel, defaults.fallbackModel, "llamaCpp.fallbackModel");
  if (fallbackModel !== LATEST_HARNESS_FALLBACK_MODEL) {
    throw new Error(`llamaCpp.fallbackModel is pinned to ${LATEST_HARNESS_FALLBACK_MODEL} in this release`);
  }
  const workingDirectoryRaw = optionalString(raw.workingDirectory, "llamaCpp.workingDirectory") ?? defaults.workingDirectory;
  const apiKeyEnv = stringValue(raw.apiKeyEnv, defaults.apiKeyEnv, "llamaCpp.apiKeyEnv");
  if (apiKeyEnv !== "LLAMA_CPP_API_KEY") throw new Error("llamaCpp.apiKeyEnv is fixed to LLAMA_CPP_API_KEY");
  const serverArgs = stringArray(raw.serverArgs, defaults.serverArgs, "llamaCpp.serverArgs");
  const cliArgs = stringArray(raw.cliArgs, defaults.cliArgs, "llamaCpp.cliArgs");
  if (cliArgs.some((item) => item.includes("{{PROMPT}}"))) {
    throw new Error("llamaCpp.cliArgs must never place prompt text in argv; use {{PROMPT_FILE}}");
  }
  if (!cliArgs.some((item) => item.includes("{{PROMPT_FILE}}"))) {
    throw new Error("llamaCpp.cliArgs must include {{PROMPT_FILE}}");
  }
  const serverBinary = stringValue(raw.serverBinary, defaults.serverBinary, "llamaCpp.serverBinary");
  const cliBinary = stringValue(raw.cliBinary, defaults.cliBinary, "llamaCpp.cliBinary");
  const serverBinarySha256 = sha256Digest(raw.serverBinarySha256, "llamaCpp.serverBinarySha256") ?? defaults.serverBinarySha256;
  const cliBinarySha256 = sha256Digest(raw.cliBinarySha256, "llamaCpp.cliBinarySha256") ?? defaults.cliBinarySha256;
  const enabled = bool(raw.enabled, defaults.enabled);
  if (enabled && modeRaw === "managed_server" && (!path.isAbsolute(serverBinary) || !serverBinarySha256)) {
    throw new Error("enabled managed_server mode requires an absolute serverBinary and serverBinarySha256 allowlist pin");
  }
  if (enabled && modeRaw === "cli" && (!path.isAbsolute(cliBinary) || !cliBinarySha256)) {
    throw new Error("enabled cli mode requires an absolute cliBinary and cliBinarySha256 allowlist pin");
  }
  const config: LlamaCppConfig = {
    enabled,
    autoRouteSimpleLeaves: bool(raw.autoRouteSimpleLeaves, defaults.autoRouteSimpleLeaves),
    mode: modeRaw as LlamaCppMode,
    baseUrl: normalizeLoopbackUrl(raw.baseUrl, defaults.baseUrl, "llamaCpp.baseUrl"),
    apiKeyEnv,
    model: stringValue(raw.model, defaults.model, "llamaCpp.model"),
    serverBinary,
    serverArgs,
    serverAutoStart: bool(raw.serverAutoStart, defaults.serverAutoStart),
    serverStartupTimeoutSeconds: integer(raw.serverStartupTimeoutSeconds, defaults.serverStartupTimeoutSeconds, "llamaCpp.serverStartupTimeoutSeconds", 1, 3_600),
    cliBinary,
    cliArgs,
    requestTimeoutSeconds: integer(raw.requestTimeoutSeconds, defaults.requestTimeoutSeconds, "llamaCpp.requestTimeoutSeconds", 1, 14_400),
    maxFilesPerTask: integer(raw.maxFilesPerTask, defaults.maxFilesPerTask, "llamaCpp.maxFilesPerTask", 1, 100),
    maxContextFiles: integer(raw.maxContextFiles, defaults.maxContextFiles, "llamaCpp.maxContextFiles", 0, 100),
    maxContextBytes: integer(raw.maxContextBytes, defaults.maxContextBytes, "llamaCpp.maxContextBytes", 1_000, 100_000_000),
    maxFileBytes: integer(raw.maxFileBytes, defaults.maxFileBytes, "llamaCpp.maxFileBytes", 1_000, 100_000_000),
    maxOutputTokens: integer(raw.maxOutputTokens, defaults.maxOutputTokens, "llamaCpp.maxOutputTokens", 1, 10_000_000),
    fallbackEnabled: bool(raw.fallbackEnabled, defaults.fallbackEnabled),
    fallbackModel: LATEST_HARNESS_FALLBACK_MODEL,
  };
  if (serverBinarySha256) config.serverBinarySha256 = serverBinarySha256;
  if (cliBinarySha256) config.cliBinarySha256 = cliBinarySha256;
  if (workingDirectoryRaw) config.workingDirectory = path.resolve(expandHome(workingDirectoryRaw));
  return config;
}

export function defaultConfigPath(): string {
  return path.resolve(expandHome(process.env.CODEX_HARNESS_CONFIG ?? "~/.config/codex-harness-bridge/config.json"));
}

export async function loadConfig(explicitPath?: string): Promise<BridgeConfig> {
  const configPath = explicitPath === undefined ? defaultConfigPath() : path.resolve(explicitPath);
  const configInfo = await lstat(configPath);
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new Error(`config must be a regular non-symlink file: ${configPath}`);
  if (typeof process.getuid === "function" && configInfo.uid !== process.getuid()) throw new Error(`config must be owned by uid ${process.getuid()}: ${configPath}`);
  if ((configInfo.mode & 0o077) !== 0) throw new Error(`config must not be accessible by group or other users (expected mode 0600): ${configPath}`);
  const parsed = record(JSON.parse(await readFile(configPath, "utf8")));
  if (![1, 2, 3, 4, 5, 6, 7].includes(Number(parsed.schemaVersion))) throw new Error(`unsupported config schema at ${configPath}`);
  const enforceHarnessPin = bool(parsed.enforceHarnessPin, true);
  const stateRoot = path.resolve(expandHome(stringValue(parsed.stateRoot, "~/.local/state/codex-harness-bridge", "stateRoot")));
  const providerRaw = record(parsed.provider);
  const providerBaseUrl = stringValue(providerRaw.baseUrl, "https://api.deepseek.com", "provider.baseUrl").replace(/\/+$/, "");
  let providerUrl: URL;
  try { providerUrl = new URL(providerBaseUrl); } catch { throw new Error("provider.baseUrl must be an absolute URL"); }
  if (providerUrl.username || providerUrl.password) throw new Error("provider.baseUrl must not embed credentials");
  const providerLoopback = ["127.0.0.1", "localhost", "::1"].includes(providerUrl.hostname.toLowerCase());
  if (providerUrl.protocol !== "https:" && !(providerUrl.protocol === "http:" && providerLoopback)) {
    throw new Error("provider.baseUrl must use HTTPS (HTTP is allowed only for loopback test providers)");
  }
  const isolationRaw = record(parsed.harnessIsolation);
  const bubblewrapBinary = path.resolve(expandHome(stringValue(isolationRaw.bubblewrapBinary, "/usr/bin/bwrap", "harnessIsolation.bubblewrapBinary")));
  const bubblewrapSha256 = sha256Digest(isolationRaw.bubblewrapSha256, "harnessIsolation.bubblewrapSha256", true)!;
  if (isolationRaw.rejectEnvFiles === false) throw new Error("harnessIsolation.rejectEnvFiles is immutable and must remain true");
  const resourceRaw = record(isolationRaw.resourceProfile);
  const resourceProfiles = ownerResourceProfiles(isolationRaw.resourceProfiles);
  for (const key of RESOURCE_LIMIT_KEYS) {
    const expected = resourceProfiles.authoritative_verification[key];
    integer(resourceRaw[key], expected, `harnessIsolation.resourceProfile.${key}`, expected, expected);
  }
  const resourceEnforcement = resourceRaw.enforcement ?? "required";
  if (resourceEnforcement !== "required" && resourceEnforcement !== "audit_only") {
    throw new Error("harnessIsolation.resourceProfile.enforcement must be required or audit_only");
  }
  const config: BridgeConfig = {
    schemaVersion: 7,
    harnessRoot: path.resolve(expandHome(stringValue(parsed.harnessRoot, "/home/zyc14588/deepseek-harness", "harnessRoot"))),
    harnessProfile: stringValue(parsed.harnessProfile, "headless", "harnessProfile"),
    harnessMinimalProfile: stringValue(parsed.harnessMinimalProfile, "codex-minimal-headless", "harnessMinimalProfile"),
    stateRoot,
    allowedRepoRoots: stringArray(parsed.allowedRepoRoots, [os.homedir()], "allowedRepoRoots").map((value) => path.resolve(expandHome(value))),
    passEnvironment: stringArray(parsed.passEnvironment, DEFAULT_PASS_ENVIRONMENT, "passEnvironment").map((item) => item.trim()).filter(Boolean),
    defaultRuntimeSeconds: integer(parsed.defaultRuntimeSeconds, 3_600, "defaultRuntimeSeconds", 60, 86_400),
    maxRuntimeSeconds: integer(parsed.maxRuntimeSeconds, 14_400, "maxRuntimeSeconds", 60, 86_400),
    logTailChars: integer(parsed.logTailChars, 20_000, "logTailChars", 1_000, 1_000_000),
    enforceHarnessPin,
    enforceHarnessBuildHash: bool(parsed.enforceHarnessBuildHash, enforceHarnessPin),
    requireCleanRepoAtStart: bool(parsed.requireCleanRepoAtStart, true),
    allowDirtyHarnessCheckout: bool(parsed.allowDirtyHarnessCheckout, false),
    controller: controllerConfig(parsed.controller),
    monitor: monitorConfig(parsed.monitor),
    provider: {
      baseUrl: providerBaseUrl,
      apiKeyFile: path.resolve(expandHome(stringValue(providerRaw.apiKeyFile, path.join(stateRoot, "secrets", "provider.key"), "provider.apiKeyFile"))),
    },
    harnessIsolation: {
      bubblewrapBinary,
      bubblewrapSha256,
      relayPort: integer(isolationRaw.relayPort, 43_128, "harnessIsolation.relayPort", 1_024, 65_535),
      rejectEnvFiles: true,
      resourceProfile: {
        enforcement: resourceEnforcement,
        systemdRunBinary: path.resolve(expandHome(stringValue(resourceRaw.systemdRunBinary, "/usr/bin/systemd-run", "harnessIsolation.resourceProfile.systemdRunBinary"))),
        systemdRunSha256: sha256Digest(resourceRaw.systemdRunSha256, "harnessIsolation.resourceProfile.systemdRunSha256", true)!,
        prlimitBinary: path.resolve(expandHome(stringValue(resourceRaw.prlimitBinary, "/usr/bin/prlimit", "harnessIsolation.resourceProfile.prlimitBinary"))),
        prlimitSha256: sha256Digest(resourceRaw.prlimitSha256, "harnessIsolation.resourceProfile.prlimitSha256", true)!,
        ...resourceProfiles.authoritative_verification,
      },
      resourceProfiles,
    },
    llamaCpp: normalizeLlamaConfig(parsed.llamaCpp),
  };
  const installationRaw = record(parsed.installation);
  if (Object.keys(installationRaw).length > 0) {
    const implementationCommit = stringValue(installationRaw.implementationCommit, "", "installation.implementationCommit");
    if (!/^[0-9a-f]{40,64}$/u.test(implementationCommit)) throw new Error("installation.implementationCommit must be a full Git object id");
    const runtimeRoot = path.resolve(expandHome(stringValue(installationRaw.runtimeRoot, "", "installation.runtimeRoot")));
    const candidatePath = stringValue(installationRaw.candidatePath, "", "installation.candidatePath");
    if (path.basename(runtimeRoot) !== candidatePath || candidatePath !== `0.6.6-candidate-${implementationCommit.slice(0, 12)}`) {
      throw new Error("installation candidate path is not bound to the implementation commit");
    }
    config.installation = { runtimeRoot, implementationCommit, candidatePath };
  }
  const registeredImplementationCommit = process.env.CODEX_HARNESS_IMPLEMENTATION_COMMIT?.trim();
  if (registeredImplementationCommit && !/^[0-9a-f]{40,64}$/u.test(registeredImplementationCommit)) {
    throw new Error("CODEX_HARNESS_IMPLEMENTATION_COMMIT must be a full Git object id");
  }
  if (registeredImplementationCommit && config.installation
    && registeredImplementationCommit !== config.installation.implementationCommit) {
    throw new Error("MCP registration implementation commit does not match installed candidate config");
  }
  if (new Set(config.passEnvironment).size !== config.passEnvironment.length) {
    throw new Error("passEnvironment must not contain duplicate names");
  }
  for (const name of config.passEnvironment) {
    if (!ALLOWED_PASS_ENVIRONMENT.has(name)) {
      throw new Error(`passEnvironment contains forbidden or secret-bearing variable: ${name}`);
    }
  }
  if (config.maxRuntimeSeconds < config.defaultRuntimeSeconds) throw new Error("maxRuntimeSeconds must be >= defaultRuntimeSeconds");
  if (!config.allowedRepoRoots.length) throw new Error("allowedRepoRoots must not be empty");
  if (typeof parsed.harnessCli === "string" && parsed.harnessCli.trim()) config.harnessCli = path.resolve(expandHome(parsed.harnessCli));
  if (typeof parsed.harnessBuildRoot === "string" && parsed.harnessBuildRoot.trim()) config.harnessBuildRoot = path.resolve(expandHome(parsed.harnessBuildRoot));
  if (typeof parsed.dshHome === "string" && parsed.dshHome.trim()) config.dshHome = path.resolve(expandHome(parsed.dshHome));
  if (typeof parsed.pinnedHarnessCommit === "string" && parsed.pinnedHarnessCommit.trim()) config.pinnedHarnessCommit = parsed.pinnedHarnessCommit.trim();
  if (typeof parsed.pinnedHarnessBuildSha256 === "string" && parsed.pinnedHarnessBuildSha256.trim()) {
    const digest = parsed.pinnedHarnessBuildSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("pinnedHarnessBuildSha256 must be a lowercase SHA-256 hex digest");
    config.pinnedHarnessBuildSha256 = digest;
  }
  return config;
}

export async function resolveHarnessLauncher(config: BridgeConfig): Promise<{ command: string; prefixArgs: string[]; source: string }> {
  const candidates: string[] = [];
  if (config.harnessCli) candidates.push(config.harnessCli);
  candidates.push(path.join(config.harnessRoot, "apps/cli/lib/bin.js"));
  candidates.push(path.join(config.harnessRoot, "apps/cli/node_modules/.bin/dsh"));
  candidates.push(path.join(config.harnessRoot, "node_modules/.bin/dsh"));
  for (const candidate of candidates) {
    if (!await pathExists(candidate)) continue;
    const source = await realpath(candidate);
    if (config.enforceHarnessPin) {
      const root = await realpath(config.harnessRoot);
      if (!isWithin(source, root)) throw new Error(`pinned Harness launcher must resolve inside harnessRoot: ${source}`);
    }
    if (/\.(?:m?js|cjs)$/.test(source)) return { command: process.execPath, prefixArgs: [source], source };
    return { command: source, prefixArgs: [], source };
  }
  if (config.enforceHarnessPin) throw new Error(`Pinned Harness launcher not found inside ${config.harnessRoot}`);
  const which = await runProcess("bash", ["-lc", "command -v dsh"], { timeoutMs: 5_000 });
  const executable = which.stdout.trim();
  if (which.code === 0 && executable) return { command: executable, prefixArgs: [], source: executable };
  throw new Error(`DeepSeek Harness launcher not found. Build ${path.join(config.harnessRoot, "apps/cli/lib/bin.js")} or set harnessCli in ${defaultConfigPath()}`);
}

export function sanitizedEnvironment(config: BridgeConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of config.passEnvironment) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = path.join(config.stateRoot, "worker-home");
  env.NO_COLOR = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_COUNT = "4";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = "/dev/null";
  env.GIT_CONFIG_KEY_1 = "commit.gpgSign";
  env.GIT_CONFIG_VALUE_1 = "false";
  env.GIT_CONFIG_KEY_2 = "tag.gpgSign";
  env.GIT_CONFIG_VALUE_2 = "false";
  env.GIT_CONFIG_KEY_3 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_3 = "false";
  return env;
}
