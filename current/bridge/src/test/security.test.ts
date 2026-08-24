import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureOperatorToken, OperatorAuthGuard, readProviderApiKey, replaceOperatorToken, validateOperatorToken } from "../security.js";
import type { BridgeConfig } from "../types.js";

test("operator password validation applies NFC and rejects weak or invisible Unicode", () => {
  assert.throws(() => validateOperatorToken("12345678901"), /at least 12 characters/u);
  assert.throws(() => validateOperatorToken("this password is deliberately long enough"), /without whitespace/u);
  assert.throws(() => validateOperatorToken("safe-password\u200b"), /zero-width/u);
  assert.throws(() => validateOperatorToken("safe-password\u202e"), /bidi-control/u);
  assert.throws(() => validateOperatorToken("safe-password\u0001"), /control/u);
  assert.equal(validateOperatorToken("123456789012"), "123456789012");
  assert.equal(validateOperatorToken("甲乙丙丁戊己庚辛壬癸子丑"), "甲乙丙丁戊己庚辛壬癸子丑");
  assert.equal(validateOperatorToken("Cafe\u0301-Password"), "Café-Password");
});

test("operator password rotation is atomic, private, and immediately persistent", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-password-"));
  const config = { stateRoot } as BridgeConfig;
  try {
    const original = await ensureOperatorToken(config);
    const replacement = "replacement-password";
    assert.notEqual(original, replacement);
    assert.equal(await replaceOperatorToken(config, replacement), replacement);
    const target = path.join(stateRoot, "secrets", "operator.token");
    assert.equal((await readFile(target, "utf8")).trim(), replacement);
    const info = await lstat(target);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("operator authentication uses exponential backoff and credential-free audit records", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-auth-"));
  const config = { stateRoot } as BridgeConfig;
  const expected = "a".repeat(64);
  const wrong = "wrong-password-value";
  try {
    const guard = new OperatorAuthGuard(config);
    const first = await guard.authorize(`Bearer ${wrong}`, expected, "127.0.0.1", 1_000);
    assert.equal(first.status, 401);
    assert.equal(first.retryAfterMs, 250);
    const blocked = await guard.authorize(`Bearer ${wrong}`, expected, "127.0.0.1", 1_100);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfterMs, 150);
    const second = await guard.authorize(`Bearer ${wrong}`, expected, "127.0.0.1", 1_300);
    assert.equal(second.status, 401);
    assert.equal(second.retryAfterMs, 500);
    const recovered = await guard.authorize(`Bearer ${expected}`, expected, "127.0.0.1", 1_301);
    assert.equal(recovered.ok, true, "valid operator credential must recover without a self-DoS lockout");
    const auditPath = path.join(stateRoot, "audit", "operator-auth.ndjson");
    const audit = await readFile(auditPath, "utf8");
    assert.match(audit, /"event":"failure"/u);
    assert.match(audit, /"event":"blocked_summary"/u);
    assert.match(audit, /"event":"recovered"/u);
    assert.doesNotMatch(audit, new RegExp(`${wrong}|${expected}`, "u"));
    assert.equal((await lstat(auditPath)).mode & 0o777, 0o600);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("operator authentication flood is source-aggregated instead of append-per-request", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-auth-flood-"));
  const config = {
    stateRoot,
    monitor: { operatorAuthAudit: { maxBytes: 65_536, maxFiles: 4, retentionDays: 30, blockedSummaryIntervalSeconds: 60 } },
  } as BridgeConfig;
  const expected = "a".repeat(64);
  try {
    const guard = new OperatorAuthGuard(config);
    await guard.authorize("Bearer wrong", expected, "127.0.0.1", 1_000);
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const blocked = await guard.authorize("Bearer wrong", expected, "127.0.0.1", 1_001);
      assert.equal(blocked.status, 429);
    }
    await guard.authorize(`Bearer ${expected}`, expected, "127.0.0.1", 1_002);
    const audit = await readFile(path.join(stateRoot, "audit", "operator-auth.ndjson"), "utf8");
    const records = audit.trim().split("\n").map((line) => JSON.parse(line) as { event?: string; blockedAttempts?: number });
    assert.ok(records.length < 32, `flood generated ${records.length} audit rows`);
    assert.ok(records.some((record) => record.event === "blocked_summary" && record.blockedAttempts === 5_000));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("operator audit rotation enforces total bytes, segment count, modes, and retention", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-auth-rotation-"));
  const policy = { maxBytes: 4_096, maxFiles: 3, retentionDays: 1, blockedSummaryIntervalSeconds: 60 };
  const config = { stateRoot, monitor: { operatorAuthAudit: policy } } as BridgeConfig;
  try {
    const guard = new OperatorAuthGuard(config);
    for (let source = 0; source < 200; source += 1) {
      await guard.authorize(undefined, "a".repeat(64), `local-source-${source}`, Date.now() + source);
    }
    const auditDirectory = path.join(stateRoot, "audit");
    const segments = (await readdir(auditDirectory)).filter((name) => /^operator-auth\.ndjson(?:\.\d+)?$/u.test(name));
    assert.ok(segments.length <= policy.maxFiles);
    let totalBytes = 0;
    for (const name of segments) {
      const info = await lstat(path.join(auditDirectory, name));
      totalBytes += info.size;
      assert.equal(info.mode & 0o777, 0o600);
    }
    assert.ok(totalBytes <= policy.maxBytes, `${totalBytes} > ${policy.maxBytes}`);

    const expired = path.join(auditDirectory, "operator-auth.ndjson.2");
    await writeFile(expired, "expired\n", { mode: 0o600 });
    await chmod(expired, 0o600);
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(expired, old, old);
    await guard.authorize(undefined, "a".repeat(64), "retention-trigger", Date.now() + 1_000);
    try {
      assert.notEqual(await readFile(expired, "utf8"), "expired\n");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("operator relaxation does not weaken the Provider API key minimum", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-provider-secret-"));
  const target = path.join(stateRoot, "provider.key");
  try {
    await writeFile(target, "123456\n", { mode: 0o600 });
    const config = { provider: { apiKeyFile: target } } as BridgeConfig;
    await assert.rejects(() => readProviderApiKey(config), /24-16384 bytes/u);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
