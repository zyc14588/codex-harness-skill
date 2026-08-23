import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testConfig } from "./test-config.js";
import { withMutationLock } from "../store.js";
import { sleep } from "../util.js";
function configFor(stateRoot) {
    return testConfig(stateRoot);
}
test("mutation lock serializes live owners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-lock-test-"));
    try {
        const config = configFor(root);
        let active = 0;
        let maximum = 0;
        const enter = async (delay) => await withMutationLock(config, async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await sleep(delay);
            active -= 1;
        });
        await Promise.all([enter(150), enter(10)]);
        assert.equal(maximum, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("mutation lock reclaims a dead recorded owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-dead-lock-test-"));
    try {
        const config = configFor(root);
        const digest = createHash("sha256").update("global-mutation").digest("hex").slice(0, 24);
        const lockPath = path.join(root, "locks", `${digest}.lock`);
        await mkdir(lockPath, { recursive: true });
        await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
            pid: 2_147_483_647,
            acquiredAt: "2000-01-01T00:00:00.000Z",
            lockName: "global-mutation",
        })}\n`);
        const old = new Date(Date.now() - 60_000);
        await utimes(lockPath, old, old);
        const result = await withMutationLock(config, async () => "reclaimed");
        assert.equal(result, "reclaimed");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=locks.test.js.map