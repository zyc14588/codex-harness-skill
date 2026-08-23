import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./types.js";

const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 16_384;

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

export function operatorTokenPath(config: BridgeConfig): string {
  return path.join(config.stateRoot, "secrets", "operator.token");
}

export function monitorSocketDirectory(config: BridgeConfig): string {
  return path.join(config.stateRoot, "monitor-internal");
}

export function monitorSocketPath(config: BridgeConfig): string {
  return path.join(monitorSocketDirectory(config), "monitor.sock");
}

async function assertPrivateRegularFile(target: string, label: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${target}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by uid ${process.getuid()}: ${target}`);
  }
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600: ${target}`);
  if (info.size < SECRET_MIN_BYTES || info.size > SECRET_MAX_BYTES) {
    throw new Error(`${label} must contain ${SECRET_MIN_BYTES}-${SECRET_MAX_BYTES} bytes: ${target}`);
  }
  const canonical = await realpath(target);
  if (canonical !== path.resolve(target)) throw new Error(`${label} path must not traverse symlinks: ${target}`);
}

export async function readPrivateSecret(target: string, label: string): Promise<string> {
  await assertPrivateRegularFile(target, label);
  const value = (await readFile(target, "utf8")).trim();
  if (Buffer.byteLength(value, "utf8") < SECRET_MIN_BYTES || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a single non-empty secret line of at least ${SECRET_MIN_BYTES} bytes`);
  }
  return value;
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
  return await readPrivateSecret(target, "monitor operator token");
}

export function validateOperatorToken(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || /\s/u.test(value)) {
    throw new Error("new operator password must be a single line without whitespace");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < SECRET_MIN_BYTES || bytes > SECRET_MAX_BYTES || value.includes("\0")) {
    throw new Error(`new operator password must contain ${SECRET_MIN_BYTES}-${SECRET_MAX_BYTES} UTF-8 bytes`);
  }
  return value;
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
    return await readPrivateSecret(target, "monitor operator token");
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readProviderApiKey(config: BridgeConfig): Promise<string> {
  return await readPrivateSecret(config.provider.apiKeyFile, "Provider API key");
}
