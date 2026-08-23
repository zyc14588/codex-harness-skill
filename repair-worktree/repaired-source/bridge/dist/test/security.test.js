import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureOperatorToken, replaceOperatorToken, validateOperatorToken } from "../security.js";
test("operator password validation requires a bounded whitespace-free bearer", () => {
    assert.throws(() => validateOperatorToken("too-short"), /24-16384/u);
    assert.throws(() => validateOperatorToken("this password is deliberately long enough"), /without whitespace/u);
    assert.equal(validateOperatorToken("operator-password-rotation-0001"), "operator-password-rotation-0001");
});
test("operator password rotation is atomic, private, and immediately persistent", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-harness-operator-password-"));
    const config = { stateRoot };
    try {
        const original = await ensureOperatorToken(config);
        const replacement = "operator-password-rotation-0002";
        assert.notEqual(original, replacement);
        assert.equal(await replaceOperatorToken(config, replacement), replacement);
        const target = path.join(stateRoot, "secrets", "operator.token");
        assert.equal((await readFile(target, "utf8")).trim(), replacement);
        const info = await lstat(target);
        assert.equal(info.isFile(), true);
        assert.equal(info.isSymbolicLink(), false);
        assert.equal(info.mode & 0o777, 0o600);
    }
    finally {
        await rm(stateRoot, { recursive: true, force: true });
    }
});
//# sourceMappingURL=security.test.js.map