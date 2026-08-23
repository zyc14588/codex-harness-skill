import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureOperatorToken, readProviderApiKey, replaceOperatorToken, validateOperatorToken } from "../security.js";
import type { BridgeConfig } from "../types.js";

test("operator password validation requires a bounded whitespace-free bearer", () => {
  assert.throws(() => validateOperatorToken("12345"), /at least 6 characters/u);
  assert.throws(() => validateOperatorToken("this password is deliberately long enough"), /without whitespace/u);
  assert.equal(validateOperatorToken("123456"), "123456");
  assert.equal(validateOperatorToken("甲乙丙丁戊己"), "甲乙丙丁戊己");
});

test("operator password rotation is atomic, private, and immediately persistent", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-password-"));
  const config = { stateRoot } as BridgeConfig;
  try {
    const original = await ensureOperatorToken(config);
    const replacement = "abcdef";
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
