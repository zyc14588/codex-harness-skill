import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import * as https from "node:https";
export const CREDENTIAL_POLICY = "DEDICATED_DISPOSABLE_MANUAL_REVOKE_VERIFIED";
export const OFFICIAL_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const OFFICIAL_DEEPSEEK_MODELS_ENDPOINT = `${OFFICIAL_DEEPSEEK_BASE_URL}/models`;
export const REVOCATION_ACCEPTED_STATUSES = Object.freeze([401, 403]);
export const REVOCATION_MAX_WAIT_SECONDS = 900;
export const REVOCATION_POLL_INTERVAL_SECONDS = 15;
export class CredentialRevocationNotObservedError extends Error {
    code = "FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED";
    constructor() {
        super("FAIL_CREDENTIAL_REVOCATION_NOT_OBSERVED");
        this.name = "CredentialRevocationNotObservedError";
    }
}
export function credentialFingerprintSha256(rawBytes) {
    assert.ok(rawBytes.byteLength >= 24, "real Provider API key is malformed");
    return createHash("sha256").update(rawBytes).digest("hex");
}
export async function readProtectedProviderCredential(source) {
    const info = await lstat(source);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "real Provider credential source must be a regular non-symlink file");
    if (typeof process.getuid === "function")
        assert.equal(info.uid, process.getuid(), "real Provider credential source must be operator-owned");
    assert.equal(info.mode & 0o077, 0, "real Provider credential source must not be accessible by group or other users");
    const document = await readFile(source, "utf8");
    const line = document.split(/\r?\n/u).find((candidate) => /^\s*DEEPSEEK_API_KEY\s*:/u.test(candidate));
    assert.ok(line, "real Provider credential source does not contain DEEPSEEK_API_KEY");
    let value = line.replace(/^\s*DEEPSEEK_API_KEY\s*:\s*/u, "").trim();
    if (value.startsWith('"') && value.endsWith('"'))
        value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'"))
        value = value.slice(1, -1).replace(/''/gu, "'");
    assert.ok(Buffer.byteLength(value, "utf8") >= 24 && !/[\0\r\n]/u.test(value), "real Provider API key is malformed");
    const rawBytes = Buffer.from(value, "utf8");
    return { value, fingerprintSha256: credentialFingerprintSha256(rawBytes) };
}
export function isCredentialRevocationStatus(httpStatus) {
    return REVOCATION_ACCEPTED_STATUSES.includes(httpStatus);
}
export async function probeOfficialDeepSeekCredential(apiKey, timeoutMs) {
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (status) => {
            if (settled)
                return;
            settled = true;
            resolve(status);
        };
        const request = https.request(OFFICIAL_DEEPSEEK_MODELS_ENDPOINT, {
            method: "GET",
            headers: {
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
            },
        }, (response) => {
            const status = Number(response.statusCode ?? 0);
            response.resume(); // Deliberately discard; no credential probe response body is captured.
            finish(Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0);
        });
        request.setTimeout(Math.max(1, timeoutMs), () => request.destroy(new Error("credential revocation probe timeout")));
        request.once("error", () => finish(0));
        request.end();
    });
}
export async function waitForCredentialRevocation(options) {
    assert.match(options.credentialFingerprintSha256, /^[0-9a-f]{64}$/u);
    assert.match(options.headSha, /^[0-9a-f]{40,64}$/u);
    assert.match(options.headTree, /^[0-9a-f]{40,64}$/u);
    assert.ok(Number.isSafeInteger(options.runId) && options.runId > 0);
    assert.ok(Number.isSafeInteger(options.runAttempt) && options.runAttempt > 0);
    const maxWaitSeconds = options.maxWaitSeconds ?? REVOCATION_MAX_WAIT_SECONDS;
    const pollIntervalSeconds = options.pollIntervalSeconds ?? REVOCATION_POLL_INTERVAL_SECONDS;
    assert.ok(Number.isSafeInteger(maxWaitSeconds) && maxWaitSeconds > 0);
    assert.ok(Number.isSafeInteger(pollIntervalSeconds) && pollIntervalSeconds > 0);
    const now = options.now ?? Date.now;
    const delay = options.delay ?? (async (milliseconds) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
    const startedAtMs = now();
    const deadlineMs = startedAtMs + maxWaitSeconds * 1_000;
    let attempt = 0;
    while (now() < deadlineMs) {
        const beforeProbeMs = now();
        const remainingMs = Math.max(1, deadlineMs - beforeProbeMs);
        let httpStatus = 0;
        try {
            const observed = await options.probe(Math.min(pollIntervalSeconds * 1_000, remainingMs));
            if (Number.isInteger(observed) && observed >= 100 && observed <= 599)
                httpStatus = observed;
        }
        catch {
            httpStatus = 0;
        }
        attempt += 1;
        const observedAtMs = now();
        const timestamp = new Date(observedAtMs).toISOString();
        options.onAttempt?.({ httpStatus, attempt, timestamp });
        if (isCredentialRevocationStatus(httpStatus) && observedAtMs <= deadlineMs) {
            return {
                schemaVersion: 1,
                result: "PASS",
                provider: "deepseek",
                credentialPolicy: CREDENTIAL_POLICY,
                credentialFingerprintSha256: options.credentialFingerprintSha256,
                repository: options.repository,
                headSha: options.headSha,
                headTree: options.headTree,
                runId: options.runId,
                runAttempt: options.runAttempt,
                endpoint: OFFICIAL_DEEPSEEK_MODELS_ENDPOINT,
                revocationObservedAt: timestamp,
                revocationHttpStatus: httpStatus,
                acceptedStatuses: REVOCATION_ACCEPTED_STATUSES,
                probeAttempts: attempt,
                maxWaitSeconds,
                pollIntervalSeconds,
                responseBodyCaptured: false,
            };
        }
        const afterProbeMs = now();
        if (afterProbeMs >= deadlineMs)
            break;
        await delay(Math.min(pollIntervalSeconds * 1_000, deadlineMs - afterProbeMs));
    }
    throw new CredentialRevocationNotObservedError();
}
//# sourceMappingURL=provider-credential.js.map