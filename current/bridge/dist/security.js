import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
const PRIVATE_SECRET_MIN_BYTES = 24;
export const OPERATOR_PASSWORD_MIN_CHARACTERS = 12;
const SECRET_MAX_BYTES = 16_384;
const AUTH_BACKOFF_BASE_MS = 250;
const AUTH_BACKOFF_MAX_MS = 30_000;
const AUTH_FAILURE_RETENTION_MS = 15 * 60_000;
const MAX_AUTH_FAILURE_SOURCES = 4_096;
export const DEFAULT_OPERATOR_AUTH_AUDIT_POLICY = {
    maxBytes: 1_048_576,
    maxFiles: 4,
    retentionDays: 30,
    blockedSummaryIntervalSeconds: 60,
};
function equalSecret(left, right) {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    if (a.length !== b.length) {
        // Preserve one constant-time operation even for mismatched lengths.
        const padded = Buffer.alloc(a.length);
        timingSafeEqual(a, padded);
        return false;
    }
    return timingSafeEqual(a, b);
}
export function bearerToken(requestAuthorization) {
    if (typeof requestAuthorization !== "string")
        return undefined;
    const match = /^Bearer[ \t]+([^\s]+)$/i.exec(requestAuthorization.trim());
    return match?.[1];
}
export function authorizeBearer(requestAuthorization, expected) {
    const candidate = bearerToken(requestAuthorization);
    return candidate !== undefined && equalSecret(candidate, expected);
}
export function authorizeExactSecret(candidate, expected) {
    return candidate !== undefined && equalSecret(candidate, expected);
}
/** Per-monitor backoff with credential-free, aggregated, bounded, rotated audit records. */
export class OperatorAuthGuard {
    #config;
    #failures = new Map();
    #auditTail = Promise.resolve();
    constructor(config) {
        this.#config = config;
    }
    #policy() {
        return this.#config.monitor?.operatorAuthAudit ?? DEFAULT_OPERATOR_AUTH_AUDIT_POLICY;
    }
    async #writeAudit(source, event, failures, retryAfterMs, nowMs, blockedAttempts) {
        const directory = path.join(this.#config.stateRoot, "audit");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryInfo = await lstat(directory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
            throw new Error(`operator audit path is not a regular directory: ${directory}`);
        if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())
            throw new Error(`operator audit directory must be owned by uid ${process.getuid()}`);
        await chmod(directory, 0o700);
        const target = path.join(directory, "operator-auth.ndjson");
        const line = `${JSON.stringify({
            schemaVersion: 2,
            at: new Date(nowMs).toISOString(),
            event,
            source: source.slice(0, 200),
            failures,
            retryAfterMs,
            ...(blockedAttempts === undefined ? {} : { blockedAttempts }),
        })}\n`;
        const policy = this.#policy();
        const retentionCutoff = Date.now() - policy.retentionDays * 86_400_000;
        const segmentPath = (index) => index === 0 ? target : `${target}.${index}`;
        const existing = async (candidate) => {
            try {
                const info = await lstat(candidate);
                if (!info.isFile() || info.isSymbolicLink())
                    throw new Error(`operator audit segment must be a regular non-symlink file: ${candidate}`);
                if (typeof process.getuid === "function" && info.uid !== process.getuid())
                    throw new Error(`operator audit segment must be owned by uid ${process.getuid()}: ${candidate}`);
                return info;
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return undefined;
                throw error;
            }
        };
        for (let index = 0; index < policy.maxFiles; index += 1) {
            const candidate = segmentPath(index);
            const info = await existing(candidate);
            if (info && info.mtimeMs < retentionCutoff)
                await rm(candidate, { force: true });
        }
        const segmentMaxBytes = Math.floor(policy.maxBytes / policy.maxFiles);
        const active = await existing(target);
        if (active && Number(active.size) + Buffer.byteLength(line) > segmentMaxBytes) {
            if (policy.maxFiles === 1) {
                await rm(target, { force: true });
            }
            else {
                for (let index = policy.maxFiles - 1; index >= 1; index -= 1) {
                    const sourcePath = segmentPath(index - 1);
                    const destinationPath = segmentPath(index);
                    if (index === policy.maxFiles - 1)
                        await rm(destinationPath, { force: true });
                    if (await existing(sourcePath))
                        await rename(sourcePath, destinationPath);
                }
            }
        }
        await appendFile(target, line, { encoding: "utf8", mode: 0o600 });
        await chmod(target, 0o600);
    }
    async #audit(source, event, failures, retryAfterMs, nowMs, blockedAttempts) {
        const operation = this.#auditTail.then(async () => await this.#writeAudit(source, event, failures, retryAfterMs, nowMs, blockedAttempts));
        this.#auditTail = operation.catch(() => undefined);
        await operation;
    }
    async #flushBlockedSummary(source, state, nowMs, force) {
        if (state.blockedAttempts <= state.reportedBlockedAttempts)
            return;
        const intervalMs = this.#policy().blockedSummaryIntervalSeconds * 1_000;
        const intervalDue = state.lastBlockedSummaryMs === undefined || nowMs - state.lastBlockedSummaryMs >= intervalMs;
        const magnitudeDue = state.blockedAttempts >= Math.max(1, state.reportedBlockedAttempts * 2);
        if (!force && !intervalDue && !magnitudeDue)
            return;
        await this.#audit(source, "blocked_summary", state.failures, Math.max(0, state.blockedUntilMs - nowMs), nowMs, state.blockedAttempts);
        state.reportedBlockedAttempts = state.blockedAttempts;
        state.lastBlockedSummaryMs = nowMs;
    }
    async authorize(requestAuthorization, expected, source, nowMs = Date.now()) {
        const key = source.slice(0, 200) || "unknown-local-client";
        for (const [candidate, state] of [...this.#failures]) {
            if (nowMs - state.lastFailureMs > AUTH_FAILURE_RETENTION_MS) {
                await this.#flushBlockedSummary(candidate, state, nowMs, true);
                this.#failures.delete(candidate);
            }
        }
        const existing = this.#failures.get(key);
        if (authorizeBearer(requestAuthorization, expected)) {
            if (existing) {
                await this.#flushBlockedSummary(key, existing, nowMs, true);
                this.#failures.delete(key);
                await this.#audit(key, "recovered", existing.failures, 0, nowMs);
            }
            return { ok: true, status: 200, retryAfterMs: 0 };
        }
        if (existing && existing.blockedUntilMs > nowMs) {
            const retryAfterMs = existing.blockedUntilMs - nowMs;
            existing.blockedAttempts += 1;
            existing.lastFailureMs = nowMs;
            await this.#flushBlockedSummary(key, existing, nowMs, false);
            return { ok: false, status: 429, retryAfterMs };
        }
        if (existing)
            await this.#flushBlockedSummary(key, existing, nowMs, true);
        if (!existing && this.#failures.size >= MAX_AUTH_FAILURE_SOURCES) {
            const oldest = [...this.#failures.entries()].sort((left, right) => left[1].lastFailureMs - right[1].lastFailureMs)[0];
            if (oldest) {
                await this.#flushBlockedSummary(oldest[0], oldest[1], nowMs, true);
                this.#failures.delete(oldest[0]);
            }
        }
        const failures = (existing?.failures ?? 0) + 1;
        const retryAfterMs = Math.min(AUTH_BACKOFF_MAX_MS, AUTH_BACKOFF_BASE_MS * (2 ** Math.min(16, failures - 1)));
        this.#failures.set(key, {
            failures,
            blockedUntilMs: nowMs + retryAfterMs,
            lastFailureMs: nowMs,
            blockedAttempts: 0,
            reportedBlockedAttempts: 0,
        });
        await this.#audit(key, "failure", failures, retryAfterMs, nowMs);
        return { ok: false, status: 401, retryAfterMs };
    }
}
export function operatorTokenPath(config) {
    return path.join(config.stateRoot, "secrets", "operator.token");
}
export function monitorSocketDirectory(config) {
    return path.join(config.stateRoot, "monitor-internal");
}
export function monitorSocketPath(config) {
    return path.join(monitorSocketDirectory(config), "monitor.sock");
}
async function assertPrivateRegularFile(target, label, minimumBytes) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`${label} must be a regular non-symlink file: ${target}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error(`${label} must be owned by uid ${process.getuid()}: ${target}`);
    }
    if ((info.mode & 0o777) !== 0o600)
        throw new Error(`${label} must have mode 0600: ${target}`);
    if (info.size < minimumBytes || info.size > SECRET_MAX_BYTES + 1) {
        throw new Error(`${label} must contain ${minimumBytes}-${SECRET_MAX_BYTES} bytes: ${target}`);
    }
    const canonical = await realpath(target);
    if (canonical !== path.resolve(target))
        throw new Error(`${label} path must not traverse symlinks: ${target}`);
}
export async function readPrivateSecret(target, label, minimumBytes = PRIVATE_SECRET_MIN_BYTES) {
    await assertPrivateRegularFile(target, label, minimumBytes);
    const value = (await readFile(target, "utf8")).trim();
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < minimumBytes || bytes > SECRET_MAX_BYTES || value.includes("\0") || /[\r\n]/.test(value)) {
        throw new Error(`${label} must be a single secret line of ${minimumBytes}-${SECRET_MAX_BYTES} bytes`);
    }
    return value;
}
async function readOperatorToken(target, label) {
    return validateOperatorToken(await readPrivateSecret(target, label, 1), label);
}
export async function ensureOperatorToken(config) {
    const target = operatorTokenPath(config);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700);
    try {
        const handle = await open(target, "wx", 0o600);
        try {
            await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    return await readOperatorToken(target, "monitor operator token");
}
export function validateOperatorToken(value, label = "new operator password") {
    if (typeof value !== "string" || value !== value.trim() || /\s/u.test(value)) {
        throw new Error(`${label} must be a single line without whitespace`);
    }
    const normalized = value.normalize("NFC");
    if (/[\p{Cc}\p{Cf}]/u.test(normalized)) {
        throw new Error(`${label} must not contain control, format, bidi-control, or zero-width characters`);
    }
    const bytes = Buffer.byteLength(normalized, "utf8");
    const characters = Array.from(normalized).length;
    if (characters < OPERATOR_PASSWORD_MIN_CHARACTERS || bytes > SECRET_MAX_BYTES || normalized.includes("\0")) {
        throw new Error(`${label} must contain at least ${OPERATOR_PASSWORD_MIN_CHARACTERS} characters and at most ${SECRET_MAX_BYTES} UTF-8 bytes`);
    }
    return normalized;
}
export async function replaceOperatorToken(config, value) {
    const selected = validateOperatorToken(value);
    const target = operatorTokenPath(config);
    await ensureOperatorToken(config);
    const parent = path.dirname(target);
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== path.resolve(parent))
        throw new Error(`monitor secret directory must not traverse symlinks: ${parent}`);
    const temporary = path.join(parent, `.operator.token.tmp.${process.pid}.${randomBytes(8).toString("hex")}`);
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${selected}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, target);
        await chmod(target, 0o600);
        return await readOperatorToken(target, "monitor operator token");
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
export async function readProviderApiKey(config) {
    return await readPrivateSecret(config.provider.apiKeyFile, "Provider API key");
}
//# sourceMappingURL=security.js.map