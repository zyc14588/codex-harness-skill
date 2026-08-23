import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome, isWithin, pathExists, runProcess } from "./util.js";
const DEFAULT_PASS_ENVIRONMENT = [
    "PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];
const ALLOWED_PASS_ENVIRONMENT = new Set(DEFAULT_PASS_ENVIRONMENT);
const LEGACY_MIGRATION_USD_TO_CNY = 7.2;
export const LATEST_HARNESS_FALLBACK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const DEFAULT_BUDGET = {
    gatePolicy: "input_output_tokens",
    ceilingPolicy: "operator_bounded",
    enforcement: "hard",
    maxApiCalls: 12,
    maxInputTokens: 180_000,
    maxOutputTokens: 24_000,
    maxCostCny: 2.5,
    maxCostUsd: 0.35,
};
export const MAXIMUM_BUDGET = {
    gatePolicy: "input_output_tokens",
    ceilingPolicy: "operator_bounded",
    enforcement: "hard",
    maxApiCalls: 40,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    maxCostCny: 36,
    maxCostUsd: 5,
};
export const DEFAULT_PRO_COMPLEX_BUDGET = {
    gatePolicy: "input_output_tokens",
    ceilingPolicy: "unbounded",
    enforcement: "hard",
    maxApiCalls: 120,
    maxInputTokens: 4_000_000,
    maxOutputTokens: 512_000,
    maxCostCny: 360,
    maxCostUsd: 50,
};
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function integer(value, fallback, field, min, max) {
    const selected = value === undefined ? fallback : value;
    if (!Number.isInteger(selected) || Number(selected) < min || Number(selected) > max) {
        throw new Error(`${field} must be an integer from ${min} to ${max}`);
    }
    return Number(selected);
}
function positiveNumber(value, fallback, field) {
    const selected = value === undefined ? fallback : value;
    if (typeof selected !== "number" || !Number.isFinite(selected) || selected <= 0) {
        throw new Error(`${field} must be a positive number`);
    }
    return selected;
}
function optionalNonnegativeNumber(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a non-negative number`);
    }
    return value;
}
function nullablePositiveNumber(value, fallback, field) {
    if (value === undefined)
        return fallback;
    if (value === null)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be null or a positive number`);
    }
    return value;
}
function stringValue(value, fallback, field) {
    const selected = value === undefined ? fallback : value;
    if (typeof selected !== "string" || !selected.trim() || selected.includes("\0")) {
        throw new Error(`${field} must be a non-empty string without NUL characters`);
    }
    return selected.trim();
}
function optionalString(value, field) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new Error(`${field} must be empty or a non-empty string without NUL characters`);
    }
    return value.trim();
}
function stringArray(value, fallback, field, maxItems = 256) {
    const selected = value === undefined ? fallback : value;
    if (!Array.isArray(selected) || selected.length > maxItems || !selected.every((item) => typeof item === "string" && !item.includes("\0") && item.length <= 16_000)) {
        throw new Error(`${field} must be an array of at most ${maxItems} strings without NUL characters`);
    }
    return selected.map((item) => String(item));
}
function sha256Digest(value, field, required = false) {
    if (value === undefined || value === null || value === "") {
        if (required)
            throw new Error(`${field} is required and must be a lowercase SHA-256 digest`);
        return undefined;
    }
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${field} must be a lowercase SHA-256 digest`);
    }
    return value;
}
export function normalizeTaskBudget(value, fallback, field) {
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
export function budgetWithin(value, maximum) {
    return value.maxInputTokens <= maximum.maxInputTokens &&
        value.maxOutputTokens <= maximum.maxOutputTokens;
}
function controllerConfig(value) {
    const raw = record(value);
    const defaults = { ...normalizeTaskBudget(raw.defaultHarnessBudget, DEFAULT_BUDGET, "controller.defaultHarnessBudget"), enforcement: "hard" };
    const maximum = { ...normalizeTaskBudget(raw.maximumHarnessBudget, MAXIMUM_BUDGET, "controller.maximumHarnessBudget"), enforcement: "hard" };
    const defaultProComplexBudget = { ...normalizeTaskBudget(raw.defaultProComplexBudget, DEFAULT_PRO_COMPLEX_BUDGET, "controller.defaultProComplexBudget"), enforcement: "hard" };
    if (!budgetWithin(defaults, maximum))
        throw new Error("controller.defaultHarnessBudget must not exceed controller.maximumHarnessBudget");
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
    if (splitMemory.anomalyPenalty >= 1)
        throw new Error("controller.splitMemory.anomalyPenalty must be < 1");
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
function pricingEntry(value, field) {
    const raw = record(value);
    const result = {};
    const mappings = [
        ["inputCacheHitCnyPerMillion", raw.inputCacheHitCnyPerMillion],
        ["inputCacheMissCnyPerMillion", raw.inputCacheMissCnyPerMillion],
        ["outputCnyPerMillion", raw.outputCnyPerMillion],
        ["inputCacheHitUsdPerMillion", raw.inputCacheHitUsdPerMillion],
        ["inputCacheMissUsdPerMillion", raw.inputCacheMissUsdPerMillion],
        ["outputUsdPerMillion", raw.outputUsdPerMillion],
    ];
    for (const [name, candidate] of mappings) {
        const parsed = optionalNonnegativeNumber(candidate, `${field}.${name}`);
        if (parsed !== undefined)
            result[name] = parsed;
    }
    const cnyComplete = result.inputCacheHitCnyPerMillion !== undefined && result.inputCacheMissCnyPerMillion !== undefined && result.outputCnyPerMillion !== undefined;
    const usdComplete = result.inputCacheHitUsdPerMillion !== undefined && result.inputCacheMissUsdPerMillion !== undefined && result.outputUsdPerMillion !== undefined;
    if (!cnyComplete && !usdComplete)
        throw new Error(`${field} requires a complete CNY or USD pricing triplet`);
    if ([result.inputCacheHitCnyPerMillion, result.inputCacheMissCnyPerMillion, result.outputCnyPerMillion].some((item) => item !== undefined) && !cnyComplete) {
        throw new Error(`${field} CNY pricing must provide hit, miss, and output rates together`);
    }
    if ([result.inputCacheHitUsdPerMillion, result.inputCacheMissUsdPerMillion, result.outputUsdPerMillion].some((item) => item !== undefined) && !usdComplete) {
        throw new Error(`${field} USD pricing must provide hit, miss, and output rates together`);
    }
    return result;
}
export function assertLoopbackHost(host, field) {
    if (!["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())) {
        throw new Error(`${field} must be a loopback host (127.0.0.1, localhost, or ::1)`);
    }
}
function normalizeLoopbackUrl(value, fallback, field) {
    const baseUrl = stringValue(value, fallback, field).replace(/\/+$/, "");
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error(`${field} must be an absolute URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(`${field} must use http or https`);
    if (url.username || url.password)
        throw new Error(`${field} must not embed credentials`);
    assertLoopbackHost(url.hostname, `${field} hostname`);
    return baseUrl;
}
function monitorConfig(value) {
    const raw = record(value);
    const pricingRaw = record(raw.pricing);
    const pricing = {};
    for (const [model, candidate] of Object.entries(pricingRaw)) {
        if (!model.trim() || model.includes("\0"))
            throw new Error("monitor.pricing model names must be non-empty");
        pricing[model] = pricingEntry(candidate, `monitor.pricing.${model}`);
    }
    const host = stringValue(raw.host, "127.0.0.1", "monitor.host");
    assertLoopbackHost(host, "monitor.host");
    const currencyRaw = record(raw.currency);
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
    };
}
export function normalizeLlamaConfig(value, fallback) {
    const raw = record(value);
    const defaults = fallback ?? {
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
    if (apiKeyEnv !== "LLAMA_CPP_API_KEY")
        throw new Error("llamaCpp.apiKeyEnv is fixed to LLAMA_CPP_API_KEY");
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
    const config = {
        enabled,
        autoRouteSimpleLeaves: bool(raw.autoRouteSimpleLeaves, defaults.autoRouteSimpleLeaves),
        mode: modeRaw,
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
    if (serverBinarySha256)
        config.serverBinarySha256 = serverBinarySha256;
    if (cliBinarySha256)
        config.cliBinarySha256 = cliBinarySha256;
    if (workingDirectoryRaw)
        config.workingDirectory = path.resolve(expandHome(workingDirectoryRaw));
    return config;
}
export function defaultConfigPath() {
    return path.resolve(expandHome(process.env.CODEX_HARNESS_CONFIG ?? "~/.config/codex-harness-bridge/config.json"));
}
export async function loadConfig() {
    const configPath = defaultConfigPath();
    const configInfo = await lstat(configPath);
    if (!configInfo.isFile() || configInfo.isSymbolicLink())
        throw new Error(`config must be a regular non-symlink file: ${configPath}`);
    if (typeof process.getuid === "function" && configInfo.uid !== process.getuid())
        throw new Error(`config must be owned by uid ${process.getuid()}: ${configPath}`);
    if ((configInfo.mode & 0o077) !== 0)
        throw new Error(`config must not be accessible by group or other users (expected mode 0600): ${configPath}`);
    const parsed = record(JSON.parse(await readFile(configPath, "utf8")));
    if (![1, 2, 3, 4, 5, 6, 7].includes(Number(parsed.schemaVersion)))
        throw new Error(`unsupported config schema at ${configPath}`);
    const enforceHarnessPin = bool(parsed.enforceHarnessPin, true);
    const stateRoot = path.resolve(expandHome(stringValue(parsed.stateRoot, "~/.local/state/codex-harness-bridge", "stateRoot")));
    const providerRaw = record(parsed.provider);
    const providerBaseUrl = stringValue(providerRaw.baseUrl, "https://api.deepseek.com", "provider.baseUrl").replace(/\/+$/, "");
    let providerUrl;
    try {
        providerUrl = new URL(providerBaseUrl);
    }
    catch {
        throw new Error("provider.baseUrl must be an absolute URL");
    }
    if (providerUrl.username || providerUrl.password)
        throw new Error("provider.baseUrl must not embed credentials");
    const providerLoopback = ["127.0.0.1", "localhost", "::1"].includes(providerUrl.hostname.toLowerCase());
    if (providerUrl.protocol !== "https:" && !(providerUrl.protocol === "http:" && providerLoopback)) {
        throw new Error("provider.baseUrl must use HTTPS (HTTP is allowed only for loopback test providers)");
    }
    const isolationRaw = record(parsed.harnessIsolation);
    const bubblewrapBinary = path.resolve(expandHome(stringValue(isolationRaw.bubblewrapBinary, "/usr/bin/bwrap", "harnessIsolation.bubblewrapBinary")));
    const bubblewrapSha256 = sha256Digest(isolationRaw.bubblewrapSha256, "harnessIsolation.bubblewrapSha256", true);
    if (isolationRaw.rejectEnvFiles === false)
        throw new Error("harnessIsolation.rejectEnvFiles is immutable and must remain true");
    const config = {
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
        },
        llamaCpp: normalizeLlamaConfig(parsed.llamaCpp),
    };
    if (new Set(config.passEnvironment).size !== config.passEnvironment.length) {
        throw new Error("passEnvironment must not contain duplicate names");
    }
    for (const name of config.passEnvironment) {
        if (!ALLOWED_PASS_ENVIRONMENT.has(name)) {
            throw new Error(`passEnvironment contains forbidden or secret-bearing variable: ${name}`);
        }
    }
    if (config.maxRuntimeSeconds < config.defaultRuntimeSeconds)
        throw new Error("maxRuntimeSeconds must be >= defaultRuntimeSeconds");
    if (!config.allowedRepoRoots.length)
        throw new Error("allowedRepoRoots must not be empty");
    if (typeof parsed.harnessCli === "string" && parsed.harnessCli.trim())
        config.harnessCli = path.resolve(expandHome(parsed.harnessCli));
    if (typeof parsed.harnessBuildRoot === "string" && parsed.harnessBuildRoot.trim())
        config.harnessBuildRoot = path.resolve(expandHome(parsed.harnessBuildRoot));
    if (typeof parsed.dshHome === "string" && parsed.dshHome.trim())
        config.dshHome = path.resolve(expandHome(parsed.dshHome));
    if (typeof parsed.pinnedHarnessCommit === "string" && parsed.pinnedHarnessCommit.trim())
        config.pinnedHarnessCommit = parsed.pinnedHarnessCommit.trim();
    if (typeof parsed.pinnedHarnessBuildSha256 === "string" && parsed.pinnedHarnessBuildSha256.trim()) {
        const digest = parsed.pinnedHarnessBuildSha256.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(digest))
            throw new Error("pinnedHarnessBuildSha256 must be a lowercase SHA-256 hex digest");
        config.pinnedHarnessBuildSha256 = digest;
    }
    return config;
}
export async function resolveHarnessLauncher(config) {
    const candidates = [];
    if (config.harnessCli)
        candidates.push(config.harnessCli);
    candidates.push(path.join(config.harnessRoot, "apps/cli/lib/bin.js"));
    candidates.push(path.join(config.harnessRoot, "apps/cli/node_modules/.bin/dsh"));
    candidates.push(path.join(config.harnessRoot, "node_modules/.bin/dsh"));
    for (const candidate of candidates) {
        if (!await pathExists(candidate))
            continue;
        const source = await realpath(candidate);
        if (config.enforceHarnessPin) {
            const root = await realpath(config.harnessRoot);
            if (!isWithin(source, root))
                throw new Error(`pinned Harness launcher must resolve inside harnessRoot: ${source}`);
        }
        if (/\.(?:m?js|cjs)$/.test(source))
            return { command: process.execPath, prefixArgs: [source], source };
        return { command: source, prefixArgs: [], source };
    }
    if (config.enforceHarnessPin)
        throw new Error(`Pinned Harness launcher not found inside ${config.harnessRoot}`);
    const which = await runProcess("bash", ["-lc", "command -v dsh"], { timeoutMs: 5_000 });
    const executable = which.stdout.trim();
    if (which.code === 0 && executable)
        return { command: executable, prefixArgs: [], source: executable };
    throw new Error(`DeepSeek Harness launcher not found. Build ${path.join(config.harnessRoot, "apps/cli/lib/bin.js")} or set harnessCli in ${defaultConfigPath()}`);
}
export function sanitizedEnvironment(config) {
    const env = {};
    for (const name of config.passEnvironment) {
        const value = process.env[name];
        if (value !== undefined)
            env[name] = value;
    }
    env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
    env.HOME = path.join(config.stateRoot, "worker-home");
    env.NO_COLOR = "1";
    return env;
}
//# sourceMappingURL=config.js.map