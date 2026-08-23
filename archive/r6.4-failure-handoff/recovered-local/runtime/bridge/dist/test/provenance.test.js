import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLauncher } from "../config.js";
import { testConfig } from "./test-config.js";
import { sha256PathTree } from "../util.js";
function configFor(harnessRoot, harnessCli, enforceHarnessPin) {
    return testConfig(harnessRoot, { harnessRoot, harnessCli, enforceHarnessPin });
}
test("artifact tree hash changes with content and matches the installer helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-hash-test-"));
    try {
        await mkdir(path.join(root, "nested"));
        await writeFile(path.join(root, "nested", "a.js"), "one\n");
        const first = await sha256PathTree(root);
        const helper = new URL("../../../scripts/hash-tree.mjs", import.meta.url);
        const { runProcess } = await import("../util.js");
        const result = await runProcess(process.execPath, [helper.pathname, root], { timeoutMs: 20_000 });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout.trim(), first);
        await writeFile(path.join(root, "nested", "a.js"), "two\n");
        assert.notEqual(await sha256PathTree(root), first);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("pinned launcher must resolve inside harnessRoot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-launcher-test-"));
    try {
        const harnessRoot = path.join(root, "harness");
        const outside = path.join(root, "outside-dsh.mjs");
        await mkdir(harnessRoot);
        await writeFile(outside, "console.log('outside')\n");
        await assert.rejects(resolveHarnessLauncher(configFor(harnessRoot, outside, true)), /inside harnessRoot/);
        const allowed = await resolveHarnessLauncher(configFor(harnessRoot, outside, false));
        assert.equal(allowed.source, outside);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=provenance.test.js.map