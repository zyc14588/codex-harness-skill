import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommit } from "../git.js";
import { runProcess } from "../util.js";
async function git(cwd, args) {
    const result = await runProcess("/usr/bin/git", args, { cwd, timeoutMs: 30_000, maxCaptureChars: 100_000 });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}
async function missing(file) {
    try {
        await access(file);
        return false;
    }
    catch (error) {
        return error.code === "ENOENT";
    }
}
test("Bridge Git commits neutralize repository hooks, signing, and fsmonitor configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-git-hardening-"));
    const hooks = path.join(root, "hostile-hooks");
    const preCommitMarker = path.join(root, "pre-commit-ran");
    const fsmonitorMarker = path.join(root, "fsmonitor-ran");
    try {
        await mkdir(hooks, { recursive: true });
        const preCommit = path.join(hooks, "pre-commit");
        const fsmonitor = path.join(root, "hostile-fsmonitor");
        await writeFile(preCommit, `#!/bin/sh\nprintf ran > '${preCommitMarker}'\nexit 91\n`);
        await writeFile(fsmonitor, `#!/bin/sh\nprintf ran > '${fsmonitorMarker}'\nexit 1\n`);
        await chmod(preCommit, 0o700);
        await chmod(fsmonitor, 0o700);
        await git(root, ["init", "-q"]);
        await git(root, ["config", "user.email", "git-hardening@example.invalid"]);
        await git(root, ["config", "user.name", "Git Hardening"]);
        await writeFile(path.join(root, "tracked.txt"), "baseline\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-qm", "baseline"]);
        await git(root, ["config", "core.hooksPath", hooks]);
        await git(root, ["config", "commit.gpgSign", "true"]);
        await git(root, ["config", "tag.gpgSign", "true"]);
        await git(root, ["config", "user.signingKey", "nonexistent-owner-test-key"]);
        await git(root, ["config", "core.fsmonitor", fsmonitor]);
        await writeFile(path.join(root, "tracked.txt"), "controlled change\n");
        const committed = await createCommit(root, "controlled commit");
        assert.equal(committed.created, true);
        assert.match(committed.commit, /^[0-9a-f]{40,64}$/u);
        assert.equal(await missing(preCommitMarker), true, "repository pre-commit hook must not execute");
        assert.equal(await missing(fsmonitorMarker), true, "repository fsmonitor command must not execute");
        assert.equal(await git(root, ["show", "-s", "--format=%s", "HEAD"]), "controlled commit");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=git-hardening.test.js.map