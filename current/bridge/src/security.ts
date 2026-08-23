import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./types.js";

const PRIVATE_SECRET_MIN_BYTES = 24;
export const OPERATOR_PASSWORD_MIN_CHARACTERS = 12;
const SECRET_MAX_BYTES = 16_384;
const AUTH_BACKOFF_BASE_MS = 250;
const AUTH_BACKOFF_MAX_MS = 30_000;
const AUTH_FAILURE_RETENTION_MS = 15 * 60_000;

function equalSecret(left: string, right: string): boolean {
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

export function bearerToken(requestAuthorization: string | string[] | undefined): string | undefined {
  if (typeof requestAuthorization !== "string") return undefined;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(requestAuthorization.trim());
  return match?.[1];
}

export function authorizeBearer(requestAuthorization: string | string[] | undefined, expected: string): boolean {
  const candidate = bearerToken(requestAuthorization);
  return candidate !== undefined && equalSecret(candidate, expected);
}

export function authorizeExactSecret(candidate: string | undefined, expected: string): boolean {
  return candidate !== undefined && equalSecret(candidate, expected);
}

interface OperatorAuthFailureState {
  failures: number;
  blockedUntilMs: number;
  lastFailureMs: number;
}

export interface OperatorAuthDecision {
  ok: boolean;
  status: 200 | 401 | 429;
  retryAfterMs: number;
}

/** Per-monitor in-memory exponential backoff with a credential-free append-only audit. */
export class OperatorAuthGuard {
  readonly #config: BridgeConfig;
  readonly #failures = new Map<string, OperatorAuthFailureState>();

  constructor(config: BridgeConfig) {
    this.#config = config;
  }

  async #audit(source: string, event: "failure" | "blocked" | "recovered", failures: number, retryAfterMs: number): Promise<void> {
    const directory = path.join(this.#config.stateRoot, "audit");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const target = path.join(directory, "operator-auth.ndjson");
    await appendFile(target, `${JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      event,
      source: source.slice(0, 200),
      failures,
      retryAfterMs,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600);
  }

  async authorize(
    requestAuthorization: string | string[] | undefined,
    expected: string,
    source: string,
    nowMs = Date.now(),
  ): Promise<OperatorAuthDecision> {
    const key = source.slice(0, 200) || "unknown-local-client";
    for (const [candidate, state] of this.#failures) {
      if (nowMs - state.lastFailureMs > AUTH_FAILURE_RETENTION_MS) this.#failures.delete(candidate);
    }
    const existing = this.#failures.get(key);
    if (authorizeBearer(requestAuthorization, expected)) {
      if (existing) {
        this.#failures.delete(key);
        await this.#audit(key, "recovered", existing.failures, 0);
      }
      return { ok: true, status: 200, retryAfterMs: 0 };
    }
    if (existing && existing.blockedUntilMs > nowMs) {
      const retryAfterMs = existing.blockedUntilMs - nowMs;
      await this.#audit(key, "blocked", existing.failures, retryAfterMs);
      return { ok: false, status: 429, retryAfterMs };
    }
    const failures = (existing?.failures ?? 0) + 1;
    const retryAfterMs = Math.min(AUTH_BACKOFF_MAX_MS, AUTH_BACKOFF_BASE_MS * (2 ** Math.min(16, failures - 1)));
    this.#failures.set(key, { failures, blockedUntilMs: nowMs + retryAfterMs, lastFailureMs: nowMs });
    await this.#audit(key, "failure", failures, retryAfterMs);
    return { ok: false, status: 401, retryAfterMs };
  }
}

export function operatorTokenPath(config: BridgeConfig): string {
  return path.join(config.stateRoot, "secrets", "operator.token");
}

export function monitorSocketDirectory(config: BridgeConfig): string {
  return path.join(config.stateRoot, "monitor-internal");
}

export function monitorSocketPath(config: BridgeConfig): string {
  return path.join(monitorSocketDirectory(config), "monitor.sock");
}

async function assertPrivateRegularFile(target: string, label: string, minimumBytes: number): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${target}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by uid ${process.getuid()}: ${target}`);
  }
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600: ${target}`);
  if (info.size < minimumBytes || info.size > SECRET_MAX_BYTES + 1) {
    throw new Error(`${label} must contain ${minimumBytes}-${SECRET_MAX_BYTES} bytes: ${target}`);
  }
  const canonical = await realpath(target);
  if (canonical !== path.resolve(target)) throw new Error(`${label} path must not traverse symlinks: ${target}`);
}

export async function readPrivateSecret(
  target: string,
  label: string,
  minimumBytes = PRIVATE_SECRET_MIN_BYTES,
): Promise<string> {
  await assertPrivateRegularFile(target, label, minimumBytes);
  const value = (await readFile(target, "utf8")).trim();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > SECRET_MAX_BYTES || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a single secret line of ${minimumBytes}-${SECRET_MAX_BYTES} bytes`);
  }
  return value;
}

async function readOperatorToken(target: string, label: string): Promise<string> {
  return validateOperatorToken(await readPrivateSecret(target, label, 1), label);
}

export async function ensureOperatorToken(config: BridgeConfig): Promise<string> {
  const target = operatorTokenPath(config);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(target), 0o700);
  try {
    const handle = await open(target, "wx", 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8"); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await readOperatorToken(target, "monitor operator token");
}

export function validateOperatorToken(value: unknown, label = "new operator password"): string {
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
    throw new Error(
      `${label} must contain at least ${OPERATOR_PASSWORD_MIN_CHARACTERS} characters and at most ${SECRET_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

export async function replaceOperatorToken(config: BridgeConfig, value: unknown): Promise<string> {
  const selected = validateOperatorToken(value);
  const target = operatorTokenPath(config);
  await ensureOperatorToken(config);
  const parent = path.dirname(target);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== path.resolve(parent)) throw new Error(`monitor secret directory must not traverse symlinks: ${parent}`);
  const temporary = path.join(parent, `.operator.token.tmp.${process.pid}.${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${selected}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
    return await readOperatorToken(target, "monitor operator token");
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readProviderApiKey(config: BridgeConfig): Promise<string> {
  return await readPrivateSecret(config.provider.apiKeyFile, "Provider API key");
}
