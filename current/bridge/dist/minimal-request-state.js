import { loadConfig } from "./config.js";
import { updateTask } from "./store.js";
import { allowedToolNamesFromRequest, isMutatingBoundedLeafRequest } from "./tool-call-recovery.js";
import { nowIso } from "./util.js";
const CORE_MUTATION_TOOLS = new Set(["bash", "pwsh", "str_replace_editor"]);
const MAX_REQUEST_EVIDENCE = 64;
const SAFE_REQUEST_KEYS = new Set([
    "frequency_penalty", "input", "max_completion_tokens", "max_tokens", "messages", "model",
    "presence_penalty", "prompt", "reasoning_effort", "response_format", "seed", "stop", "stream",
    "system", "temperature", "thinking", "tool_choice", "tools", "top_p", "user",
]);
const SAFE_MESSAGE_ROLES = new Set(["assistant", "developer", "system", "tool", "user"]);
const SAFE_ENDPOINTS = new Set(["/chat/completions"]);
function normalizeToolNames(names) {
    return [...new Set(names.filter((name) => /^[A-Za-z0-9_.:-]{1,160}$/u.test(name)))].sort();
}
function sameNames(left, right) {
    const a = normalizeToolNames(left);
    const b = normalizeToolNames(right);
    return a.length === b.length && a.every((name, index) => name === b[index]);
}
function mutationContract(task) {
    const executor = task.effectiveExecutor ?? task.executor;
    return executor === "harness"
        && task.harnessMode === "minimal"
        && ["implementation", "test", "repair"].includes(task.mode)
        && task.harnessWritePaths.length > 0;
}
function coreTools(names) {
    return normalizeToolNames(names).filter((name) => CORE_MUTATION_TOOLS.has(name));
}
function missingRunnerTools(names, required) {
    const available = new Set(names);
    const shell = process.platform === "win32" ? "pwsh" : "bash";
    const expected = required === undefined ? [shell, "str_replace_editor"] : normalizeToolNames(required);
    return expected.filter((name) => !available.has(name));
}
function setToolPlaneFailure(task, kind, message) {
    task.infrastructureFailureKind = kind;
    task.infrastructureFailureDetails = message;
    task.minimalRequestPhase = "terminal";
}
function inferredPurpose(task, providerPurpose) {
    if (providerPurpose === "session-title")
        return "session_title_auxiliary";
    if (providerPurpose === "compaction")
        return "compaction_auxiliary";
    if (!mutationContract(task))
        return "non_mutating_agent_request";
    if (task.minimalRequestPhase === "primary_mutation_armed")
        return "primary_mutation";
    if (task.minimalRequestPhase === "mutation_in_progress" || task.minimalRequestPhase === "diff_observed") {
        return "mutation_followup";
    }
    return "pre_arm_auxiliary";
}
/** Record the actual Agent-scoped and assembled tool catalogs before followup. */
export async function publishMinimalRunnerSnapshot(input) {
    const config = await loadConfig();
    let failure;
    let failureKind;
    await updateTask(config, input.taskId, (task) => {
        if (task.status !== "queued" && task.status !== "running")
            throw new Error(`minimal runner cannot publish over task status ${task.status}`);
        if ((task.effectiveExecutor ?? task.executor) !== "harness" || task.harnessMode !== "minimal") {
            throw new Error("minimal runner state may only be published for a minimal Harness task");
        }
        const visible = normalizeToolNames(input.visibleTools);
        const assembled = normalizeToolNames(input.assembledTools);
        const core = coreTools(visible);
        task.minimalRunnerPresetId = input.presetId;
        task.minimalRunnerVisibleTools = visible;
        task.minimalAssembledTools = assembled;
        task.minimalCoreMutationTools = core;
        task.minimalRunnerSnapshotAt = nowIso();
        const missing = missingRunnerTools(visible, input.requiredTools);
        if (missing.length > 0) {
            failure = `minimal runner composition is missing required tools: ${missing.join(", ")}; visible=${visible.join(",")}`;
            failureKind = "minimal_tool_plane_composition";
            setToolPlaneFailure(task, failureKind, failure);
            return;
        }
        if (!sameNames(visible, assembled)) {
            failure = `minimal runner and assembled tool catalogs differ; visible=${visible.join(",")}; assembled=${assembled.join(",")}`;
            failureKind = "minimal_tool_serialization_mismatch";
            setToolPlaneFailure(task, failureKind, failure);
            return;
        }
        task.minimalRequestPhase = "agent_ready";
        if (task.infrastructureFailureKind === "minimal_tool_plane_composition"
            || task.infrastructureFailureKind === "minimal_tool_serialization_mismatch") {
            delete task.infrastructureFailureKind;
            delete task.infrastructureFailureDetails;
        }
    });
    if (failure) {
        const prefix = failureKind === "minimal_tool_serialization_mismatch"
            ? "MINIMAL_TOOL_SERIALIZATION_MISMATCH"
            : "MINIMAL_TOOL_PLANE_COMPOSITION";
        throw new Error(`${prefix}: ${failure}`);
    }
}
/** Arm the first ordinary Agent request immediately before `agent.followup()`. */
export async function armMinimalPrimaryMutation(input) {
    const config = await loadConfig();
    await updateTask(config, input.taskId, (task) => {
        if (task.minimalRequestPhase !== "agent_ready") {
            throw new Error(`minimal primary mutation cannot arm from phase ${task.minimalRequestPhase ?? "missing"}`);
        }
        task.minimalRequestPhase = "primary_mutation_armed";
        task.minimalPrimaryMutationArmedAt = nowIso();
    });
}
/** Record the exact `GenerateOptions.tools` presented to the DeepSeek adapter. */
export async function recordMinimalAdapterRequest(input) {
    const config = await loadConfig();
    let recorded;
    await updateTask(config, input.taskId, (task) => {
        if (task.status !== "queued" && task.status !== "running")
            throw new Error(`minimal adapter request observed for task status ${task.status}`);
        const requestOrdinal = (task.minimalRequestOrdinal ?? 0) + 1;
        const evidence = {
            requestOrdinal,
            purpose: inferredPurpose(task, input.purpose),
            adapterToolNames: normalizeToolNames(input.toolNames),
            adapterObservedAt: nowIso(),
            ...(input.reasoningEffort === undefined ? {} : { adapterReasoningEffort: input.reasoningEffort }),
        };
        task.minimalRequestOrdinal = requestOrdinal;
        task.minimalRequestEvidence = [...(task.minimalRequestEvidence ?? []), evidence].slice(-MAX_REQUEST_EVIDENCE);
        recorded = evidence;
    });
    if (!recorded)
        throw new Error("minimal adapter request was not recorded");
    return { requestOrdinal: recorded.requestOrdinal, purpose: recorded.purpose };
}
function wireToolName(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const record = raw;
    if (typeof record.name === "string" && record.name.length > 0)
        return record.name;
    const fn = record.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn))
        return undefined;
    const name = fn.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
}
/** Build a strict allowlist of request metadata safe to persist. */
export function buildRedactedRequestEnvelope(endpoint, body) {
    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    const roles = Array.isArray(body.messages)
        ? body.messages.flatMap((message) => {
            if (!message || typeof message !== "object" || Array.isArray(message))
                return [];
            const role = message.role;
            return typeof role === "string" && SAFE_MESSAGE_ROLES.has(role) ? [role] : [];
        })
        : [];
    const maxTokensRaw = body.max_tokens ?? body.max_completion_tokens;
    const thinking = body.thinking;
    const thinkingTypeRaw = thinking && typeof thinking === "object" && !Array.isArray(thinking)
        && typeof thinking.type === "string"
        ? thinking.type
        : undefined;
    const thinkingType = thinkingTypeRaw === "enabled" || thinkingTypeRaw === "disabled" || thinkingTypeRaw === "auto"
        ? thinkingTypeRaw
        : undefined;
    const endpointPath = endpoint.split("?", 1)[0];
    return {
        endpoint: SAFE_ENDPOINTS.has(endpointPath) ? endpointPath : "[other]",
        topLevelKeys: Object.keys(body).filter((key) => SAFE_REQUEST_KEYS.has(key)).sort(),
        toolSchemaCount: rawTools.length,
        wireToolNames: normalizeToolNames(rawTools.flatMap((tool) => {
            const name = wireToolName(tool);
            return name === undefined ? [] : [name];
        })),
        proxyParsedToolNames: normalizeToolNames([...allowedToolNamesFromRequest(body)]),
        messageRoles: [...new Set(roles)].sort(),
        ...(typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) ? { maxTokens: maxTokensRaw } : {}),
        ...(thinkingType === undefined ? {} : { thinkingType }),
        contractMarkerPresent: isMutatingBoundedLeafRequest(body),
    };
}
function requestMismatch(task, evidence) {
    const visible = task.minimalRunnerVisibleTools ?? [];
    const assembled = task.minimalAssembledTools ?? [];
    const adapter = evidence.adapterToolNames;
    const wire = evidence.wireToolNames ?? [];
    const parsed = evidence.proxyParsedToolNames ?? [];
    if (!sameNames(visible, assembled))
        return `runner visible tools differ from assembled tools; visible=${visible.join(",")}; assembled=${assembled.join(",")}`;
    if (!sameNames(assembled, adapter))
        return `assembled tools differ from DeepSeek adapter input tools; assembled=${assembled.join(",")}; adapter=${adapter.join(",")}`;
    if (!sameNames(adapter, wire))
        return `DeepSeek adapter input tools differ from wire tools; adapter=${adapter.join(",")}; wire=${wire.join(",")}`;
    if (!sameNames(wire, parsed))
        return `wire tools differ from proxy parsed tools; wire=${wire.join(",")}; parsed=${parsed.join(",")}`;
    if (coreTools(parsed).length === 0)
        return `primary mutation request has no parsed core mutation tool; parsed=${parsed.join(",")}`;
    return undefined;
}
/** Correlate one proxy request with the next adapter observation and compare all tool planes. */
export async function claimMinimalWireRequest(taskId, envelope) {
    const config = await loadConfig();
    let result;
    await updateTask(config, taskId, (task) => {
        const evidence = (task.minimalRequestEvidence ?? []).find((entry) => entry.proxyObservedAt === undefined);
        if (!evidence) {
            const snapshotReady = task.minimalRunnerSnapshotAt !== undefined;
            const kind = snapshotReady ? "minimal_tool_serialization_mismatch" : "minimal_tool_plane_composition";
            const message = snapshotReady
                ? "proxy received a wire request without a preceding DeepSeek adapter observation"
                : "proxy received a wire request before the Bridge minimal runner published its tool snapshot";
            setToolPlaneFailure(task, kind, message);
            result = { ok: false, kind, message };
            return;
        }
        Object.assign(evidence, envelope, { proxyObservedAt: nowIso() });
        if (evidence.purpose === "primary_mutation" || evidence.purpose === "mutation_followup") {
            const visibleCore = coreTools(task.minimalRunnerVisibleTools ?? []);
            if (visibleCore.length === 0) {
                const message = "primary mutation reached the proxy without a runner-scoped core mutation tool";
                setToolPlaneFailure(task, "minimal_tool_plane_composition", message);
                result = { ok: false, kind: "minimal_tool_plane_composition", message };
                return;
            }
            const mismatch = requestMismatch(task, evidence);
            if (mismatch) {
                setToolPlaneFailure(task, "minimal_tool_serialization_mismatch", mismatch);
                result = { ok: false, kind: "minimal_tool_serialization_mismatch", message: mismatch };
                return;
            }
            task.minimalRequestPhase = "mutation_in_progress";
        }
        result = { ok: true, evidence: structuredClone(evidence) };
    });
    if (!result)
        throw new Error("minimal wire request was not correlated");
    return result;
}
/** Persist forced-policy telemetry atomically before the provider POST is allowed to begin. */
export async function recordMinimalMutationPolicyApplication(input) {
    const config = await loadConfig();
    await updateTask(config, input.taskId, (task) => {
        const evidence = (task.minimalRequestEvidence ?? []).find((entry) => entry.requestOrdinal === input.requestOrdinal);
        if (!evidence || evidence.proxyObservedAt === undefined) {
            throw new Error(`minimal mutation policy cannot apply to uncorrelated request ${input.requestOrdinal}`);
        }
        if (evidence.purpose !== "primary_mutation" && evidence.purpose !== "mutation_followup") {
            throw new Error(`minimal mutation policy cannot apply to ${evidence.purpose}`);
        }
        const selected = coreTools(input.toolNames);
        if (selected.length === 0)
            throw new Error("minimal mutation policy selected no core mutation tool");
        task.minimalMutationForceCount = (task.minimalMutationForceCount ?? 0) + 1;
        task.minimalMutationForcedTools = normalizeToolNames([...(task.minimalMutationForcedTools ?? []), ...selected]);
        task.minimalMutationPolicyVersion = input.policyVersion;
        task.minimalMutationLastAt = nowIso();
        evidence.policyApplied = true;
        assertMinimalRequestInvariant(task);
    });
}
export async function recordMinimalDiffObserved(taskId) {
    const config = await loadConfig();
    await updateTask(config, taskId, (task) => {
        if (task.minimalRequestPhase === "mutation_in_progress" || task.minimalRequestPhase === "primary_mutation_armed") {
            task.minimalRequestPhase = "diff_observed";
        }
        assertMinimalRequestInvariant(task);
    });
}
/** Assert combinations that would otherwise recreate the R6.4 false state. */
export function assertMinimalRequestInvariant(task) {
    const forceCount = task.minimalMutationForceCount ?? 0;
    const forcedTools = task.minimalMutationForcedTools ?? [];
    if (task.infrastructureFailureKind === "minimal_tool_plane" && forceCount === 0) {
        throw new Error("impossible minimal request state: legacy minimal_tool_plane with zero force count");
    }
    if (forceCount > 0 && coreTools(forcedTools).length === 0) {
        throw new Error("impossible minimal request state: force count is positive without a forced core mutation tool");
    }
    const applied = (task.minimalRequestEvidence ?? []).some((entry) => entry.policyApplied === true);
    if (applied && forceCount === 0) {
        throw new Error("impossible minimal request state: policy evidence is applied while force count is zero");
    }
    const ordinals = (task.minimalRequestEvidence ?? []).map((entry) => entry.requestOrdinal);
    if (new Set(ordinals).size !== ordinals.length || ordinals.some((value, index) => index > 0 && value <= (ordinals[index - 1] ?? 0))) {
        throw new Error("impossible minimal request state: request ordinals are not unique and increasing");
    }
}
export function isAuxiliaryPurpose(purpose) {
    return purpose === "session_title_auxiliary"
        || purpose === "compaction_auxiliary"
        || purpose === "pre_arm_auxiliary";
}
export function isMutationPurpose(purpose) {
    return purpose === "primary_mutation" || purpose === "mutation_followup";
}
//# sourceMappingURL=minimal-request-state.js.map