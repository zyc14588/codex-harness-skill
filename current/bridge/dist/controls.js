import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { budgetWithin, normalizeLlamaConfig, normalizeTaskBudget } from "./config.js";
import { listTasks, withNamedLock } from "./store.js";
import { atomicWriteJson, ensureDir, nowIso, pathExists, readJson, safeTaskId } from "./util.js";
function root(config) {
    return path.join(config.stateRoot, "controls");
}
function operatorPath(config) {
    return path.join(root(config), "operator.json");
}
function overrideRoot(config) {
    return path.join(root(config), "budget-overrides");
}
function overridePath(config, budgetGroupId) {
    return path.join(overrideRoot(config), `${safeTaskId(budgetGroupId)}.json`);
}
function auditPath(config) {
    return path.join(root(config), "budget-control-audit.ndjson");
}
function actorText(value) {
    const selected = value.trim();
    if (!selected || selected.includes("\0") || selected.length > 200)
        throw new Error("actor must be 1-200 characters without NUL");
    return selected;
}
function reasonText(value) {
    const selected = value.trim();
    if (!selected || selected.includes("\0") || selected.length > 2_000)
        throw new Error("reason must be 1-2000 characters without NUL");
    return selected;
}
function initialControls(config) {
    return {
        schemaVersion: 1,
        updatedAt: nowIso(),
        updatedBy: "installation-config",
        budgetPolicy: {
            defaultHarnessBudget: { ...config.controller.defaultHarnessBudget },
            maximumHarnessBudget: { ...config.controller.maximumHarnessBudget },
            defaultProComplexBudget: { ...config.controller.defaultProComplexBudget },
        },
        llamaCpp: { ...config.llamaCpp, serverArgs: [...config.llamaCpp.serverArgs], cliArgs: [...config.llamaCpp.cliArgs] },
    };
}
const RUNTIME_LLAMA_KEYS = new Set([
    "enabled", "autoRouteSimpleLeaves", "mode", "baseUrl", "model",
    "serverAutoStart", "serverStartupTimeoutSeconds", "requestTimeoutSeconds",
    "maxFilesPerTask", "maxContextFiles", "maxContextBytes", "maxFileBytes",
    "maxOutputTokens", "fallbackEnabled", "fallbackModel",
]);
/** Runtime controls may select policy only; executable identity and argv remain installation-owned. */
function normalizeRuntimeLlama(config, value, fallback, rejectImmutable = false) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (rejectImmutable) {
        const forbidden = Object.keys(raw).filter((key) => !RUNTIME_LLAMA_KEYS.has(key));
        if (forbidden.length)
            throw new Error(`runtime llama.cpp controls cannot change installation-owned fields: ${forbidden.sort().join(", ")}`);
    }
    const candidate = { ...config.llamaCpp };
    for (const key of RUNTIME_LLAMA_KEYS) {
        if (raw[key] !== undefined)
            candidate[key] = raw[key];
        else
            candidate[key] = fallback[key];
    }
    return normalizeLlamaConfig(candidate, config.llamaCpp);
}
function parseControls(config, value) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const budgetPolicy = raw.budgetPolicy && typeof raw.budgetPolicy === "object" && !Array.isArray(raw.budgetPolicy)
        ? raw.budgetPolicy
        : {};
    const maximum = { ...normalizeTaskBudget(budgetPolicy.maximumHarnessBudget, config.controller.maximumHarnessBudget, "controls.budgetPolicy.maximumHarnessBudget"), enforcement: "hard" };
    if (!budgetWithin(maximum, config.controller.maximumHarnessBudget)) {
        throw new Error("runtime maximum budget exceeds the installation operator ceiling");
    }
    const defaults = { ...normalizeTaskBudget(budgetPolicy.defaultHarnessBudget, config.controller.defaultHarnessBudget, "controls.budgetPolicy.defaultHarnessBudget"), enforcement: "hard" };
    if (!budgetWithin(defaults, maximum))
        throw new Error("runtime default budget exceeds runtime maximum budget");
    const defaultProComplexBudget = { ...normalizeTaskBudget(budgetPolicy.defaultProComplexBudget, config.controller.defaultProComplexBudget, "controls.budgetPolicy.defaultProComplexBudget"), enforcement: "hard", ceilingPolicy: "unbounded" };
    return {
        schemaVersion: 1,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
        updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "unknown",
        budgetPolicy: { defaultHarnessBudget: defaults, maximumHarnessBudget: maximum, defaultProComplexBudget },
        llamaCpp: normalizeRuntimeLlama(config, raw.llamaCpp, config.llamaCpp),
    };
}
export async function readOperatorControls(config) {
    const target = operatorPath(config);
    if (!await pathExists(target))
        return initialControls(config);
    return parseControls(config, await readJson(target));
}
async function appendAudit(config, event) {
    await ensureDir(root(config));
    await appendFile(auditPath(config), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}
export async function setBudgetPolicy(config, defaultBudgetValue, maximumBudgetValue, defaultProComplexBudgetValue, reason, actor) {
    return await withNamedLock(config, "operator-controls", 30_000, async () => {
        const before = await readOperatorControls(config);
        const maximum = { ...normalizeTaskBudget(maximumBudgetValue, before.budgetPolicy.maximumHarnessBudget, "budgetPolicy.maximumHarnessBudget"), enforcement: "hard" };
        if (!budgetWithin(maximum, config.controller.maximumHarnessBudget)) {
            throw new Error(`runtime maximum exceeds installation operator ceiling: ${JSON.stringify(config.controller.maximumHarnessBudget)}`);
        }
        const defaults = { ...normalizeTaskBudget(defaultBudgetValue, before.budgetPolicy.defaultHarnessBudget, "budgetPolicy.defaultHarnessBudget"), enforcement: "hard" };
        if (!budgetWithin(defaults, maximum))
            throw new Error("defaultHarnessBudget must not exceed maximumHarnessBudget");
        const defaultProComplexBudget = { ...normalizeTaskBudget(defaultProComplexBudgetValue, before.budgetPolicy.defaultProComplexBudget, "budgetPolicy.defaultProComplexBudget"), enforcement: "hard", ceilingPolicy: "unbounded" };
        const next = {
            ...before,
            updatedAt: nowIso(),
            updatedBy: actorText(actor),
            budgetPolicy: { defaultHarnessBudget: defaults, maximumHarnessBudget: maximum, defaultProComplexBudget },
        };
        await atomicWriteJson(operatorPath(config), next);
        await appendAudit(config, {
            id: randomUUID(), at: next.updatedAt, actor: next.updatedBy, scope: "policy",
            reason: reasonText(reason), before: before.budgetPolicy, after: next.budgetPolicy,
        });
        return next;
    });
}
export async function effectiveBudgetPolicy(config) {
    return (await readOperatorControls(config)).budgetPolicy;
}
function parseOverride(config, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid budget override");
    const raw = value;
    const group = safeTaskId(String(raw.budgetGroupId ?? ""));
    return {
        schemaVersion: 1,
        budgetGroupId: group,
        budget: normalizeTaskBudget(raw.budget, config.controller.defaultHarnessBudget, "budgetOverride.budget"),
        reason: typeof raw.reason === "string" ? raw.reason : "unknown",
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
        updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "unknown",
    };
}
export async function readBudgetOverride(config, budgetGroupId) {
    const target = overridePath(config, budgetGroupId);
    if (!await pathExists(target))
        return undefined;
    return parseOverride(config, await readJson(target));
}
export async function listBudgetOverrides(config) {
    const directory = overrideRoot(config);
    if (!await pathExists(directory))
        return [];
    const records = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json"))
            continue;
        try {
            records.push(parseOverride(config, await readJson(path.join(directory, entry.name))));
        }
        catch { /* ignore corrupt isolated override */ }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function budgetGroupFrozenBudget(config, budgetGroupId) {
    const task = (await listTasks(config)).find((candidate) => candidate.budgetGroupId === budgetGroupId);
    if (!task)
        throw new Error(`budget group has no task record: ${budgetGroupId}`);
    return task.budget;
}
export async function setBudgetOverride(config, budgetGroupId, budgetValue, reason, actor) {
    const group = safeTaskId(budgetGroupId);
    return await withNamedLock(config, `budget-control:${group}`, 30_000, async () => {
        const policy = await effectiveBudgetPolicy(config);
        const frozen = await budgetGroupFrozenBudget(config, group);
        const before = await readBudgetOverride(config, group);
        const requested = normalizeTaskBudget(budgetValue, before?.budget ?? frozen, "budgetOverride.budget");
        const budget = { ...requested, enforcement: "hard", ceilingPolicy: frozen.ceilingPolicy ?? "operator_bounded" };
        if (budget.ceilingPolicy !== "unbounded" && !budgetWithin(budget, policy.maximumHarnessBudget)) {
            throw new Error("budget-group override exceeds current runtime maximum budget");
        }
        const record = {
            schemaVersion: 1,
            budgetGroupId: group,
            budget,
            reason: reasonText(reason),
            updatedAt: nowIso(),
            updatedBy: actorText(actor),
        };
        await atomicWriteJson(overridePath(config, group), record);
        await appendAudit(config, {
            id: randomUUID(), at: record.updatedAt, actor: record.updatedBy, scope: "budget_group",
            budgetGroupId: group, reason: record.reason, before: before?.budget ?? null, after: budget,
        });
        return record;
    });
}
export async function clearBudgetOverride(config, budgetGroupId, reason, actor) {
    const group = safeTaskId(budgetGroupId);
    await withNamedLock(config, `budget-control:${group}`, 30_000, async () => {
        const before = await readBudgetOverride(config, group);
        await rm(overridePath(config, group), { force: true });
        await appendAudit(config, {
            id: randomUUID(), at: nowIso(), actor: actorText(actor), scope: "budget_group",
            budgetGroupId: group, reason: reasonText(reason), before: before?.budget ?? null, after: null,
        });
    });
}
export async function effectiveBudget(config, frozen, budgetGroupId) {
    const policy = await effectiveBudgetPolicy(config);
    const fallback = frozen.ceilingPolicy === "unbounded" ? policy.defaultProComplexBudget : policy.defaultHarnessBudget;
    const legacyNormalized = normalizeTaskBudget(frozen, fallback, "task.budget");
    const override = await readBudgetOverride(config, budgetGroupId);
    const selected = { ...(override?.budget ?? legacyNormalized), enforcement: "hard", ceilingPolicy: legacyNormalized.ceilingPolicy ?? "operator_bounded" };
    if (selected.ceilingPolicy !== "unbounded" && !budgetWithin(selected, policy.maximumHarnessBudget)) {
        throw new Error(`effective budget exceeds current operator maximum for ${budgetGroupId}`);
    }
    return selected;
}
export async function listBudgetControlEvents(config, limit = 500) {
    const target = auditPath(config);
    if (!await pathExists(target))
        return [];
    const text = await readFile(target, "utf8");
    const values = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.id === "string" && typeof parsed.at === "string")
                values.push(parsed);
        }
        catch { /* ignore trailing partial line */ }
    }
    return values.slice(-Math.max(1, Math.min(limit, 5_000)));
}
export async function effectiveLlamaConfig(config) {
    return (await readOperatorControls(config)).llamaCpp;
}
export async function setLlamaRuntimeConfig(config, value, actor) {
    return await withNamedLock(config, "operator-controls", 30_000, async () => {
        const before = await readOperatorControls(config);
        const llamaCpp = normalizeRuntimeLlama(config, value, before.llamaCpp, true);
        const next = {
            ...before,
            updatedAt: nowIso(),
            updatedBy: actorText(actor),
            llamaCpp,
        };
        await atomicWriteJson(operatorPath(config), next);
        return llamaCpp;
    });
}
//# sourceMappingURL=controls.js.map