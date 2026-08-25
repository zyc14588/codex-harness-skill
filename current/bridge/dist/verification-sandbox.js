import { realpath } from "node:fs/promises";
import path from "node:path";
import { sha256Executable } from "./process-identity.js";
import { assertControlledResourceProfile, directoryAllocatedBytes, resourceWrappedCommand, } from "./resource-controls.js";
import { isWithin, runProcess, sleep } from "./util.js";
function destinationDirectories(paths) {
    const output = new Set();
    for (const item of paths) {
        let current = path.resolve(item);
        while (current !== "/") {
            output.add(current);
            current = path.dirname(current);
        }
    }
    return [...output].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}
async function gitCommonDirectory(worktree) {
    const result = await runProcess("/usr/bin/git", [
        "-c", "core.hooksPath=/dev/null",
        "-c", "commit.gpgSign=false",
        "-c", "tag.gpgSign=false",
        "-c", "core.fsmonitor=false",
        "-C", worktree,
        "rev-parse", "--path-format=absolute", "--git-common-dir",
    ], { timeoutMs: 10_000, maxCaptureChars: 16_000, killProcessGroup: true });
    if (result.code !== 0 || !result.stdout.trim())
        throw new Error(`cannot resolve verification Git common directory: ${result.stderr.trim()}`);
    return await realpath(result.stdout.trim());
}
export async function runVerificationSandboxCommand(config, worktreeInput, shellCommand, timeoutSeconds, profile) {
    if (process.platform !== "linux")
        throw new Error("authoritative verification requires Linux Bubblewrap isolation");
    await assertControlledResourceProfile(config, profile);
    const bwrap = await sha256Executable(config.harnessIsolation.bubblewrapBinary);
    if (bwrap.sha256 !== config.harnessIsolation.bubblewrapSha256) {
        throw new Error(`Bubblewrap SHA-256 mismatch for ${bwrap.realpath}`);
    }
    const worktree = await realpath(worktreeInput);
    const gitCommon = await gitCommonDirectory(worktree);
    if (isWithin(gitCommon, worktree))
        throw new Error("verification requires a linked worktree with a separately mountable Git common directory");
    const nodeExecutable = await realpath(process.execPath);
    const externalNode = !isWithin(nodeExecutable, "/usr");
    const destinations = ["/usr", worktree, gitCommon, ...(externalNode ? [path.dirname(nodeExecutable)] : [])];
    const args = [
        "--die-with-parent", "--new-session",
        "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
        "--cap-drop", "ALL", "--clearenv", "--hostname", "codex-harness-verify",
    ];
    for (const directory of destinationDirectories(destinations))
        args.push("--dir", directory);
    args.push("--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", worktree, worktree, "--ro-bind", gitCommon, gitCommon);
    if (externalNode)
        args.push("--ro-bind", nodeExecutable, nodeExecutable);
    const nodePath = path.dirname(nodeExecutable);
    args.push("--setenv", "PATH", `${nodePath}:/usr/local/bin:/usr/bin:/bin`, "--setenv", "HOME", "/tmp", "--setenv", "USER", "codex-harness-verify", "--setenv", "LOGNAME", "codex-harness-verify", "--setenv", "SHELL", "/bin/bash", "--setenv", "LANG", "C.UTF-8", "--setenv", "NO_COLOR", "1", "--setenv", "TMPDIR", "/tmp", "--setenv", "GIT_OPTIONAL_LOCKS", "0", "--setenv", "GIT_TERMINAL_PROMPT", "0", "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null", "--setenv", "GIT_CONFIG_COUNT", "4", "--setenv", "GIT_CONFIG_KEY_0", "core.hooksPath", "--setenv", "GIT_CONFIG_VALUE_0", "/dev/null", "--setenv", "GIT_CONFIG_KEY_1", "commit.gpgSign", "--setenv", "GIT_CONFIG_VALUE_1", "false", "--setenv", "GIT_CONFIG_KEY_2", "tag.gpgSign", "--setenv", "GIT_CONFIG_VALUE_2", "false", "--setenv", "GIT_CONFIG_KEY_3", "core.fsmonitor", "--setenv", "GIT_CONFIG_VALUE_3", "false", "--chdir", worktree, "--", "/bin/bash", "--noprofile", "--norc", "-lc", shellCommand);
    const initialBytes = await directoryAllocatedBytes(worktree);
    if (initialBytes > profile.worktreeMaxBytes) {
        throw new Error(`verification worktree already exceeds ${profile.worktreeMaxBytes} byte ceiling (${initialBytes})`);
    }
    const quotaController = new AbortController();
    let quotaFailure;
    let stopWatch = false;
    const quotaWatch = (async () => {
        while (!stopWatch && !quotaController.signal.aborted) {
            const bytes = await directoryAllocatedBytes(worktree);
            if (bytes > profile.worktreeMaxBytes) {
                quotaFailure = `verification worktree exceeded ${profile.worktreeMaxBytes} byte ceiling (${bytes})`;
                quotaController.abort(quotaFailure);
                return;
            }
            await sleep(250);
        }
    })();
    const wrapped = await resourceWrappedCommand(config, "authoritative-verification", bwrap.realpath, args, profile);
    let result;
    try {
        result = await runProcess(wrapped.command, wrapped.args, {
            env: wrapped.env,
            timeoutMs: Math.min(timeoutSeconds, profile.commandTimeoutSeconds) * 1_000,
            maxCaptureChars: 200_000,
            killProcessGroup: true,
            signal: quotaController.signal,
            abortGraceMs: 1_000,
        });
    }
    finally {
        stopWatch = true;
        await quotaWatch;
    }
    if (quotaFailure)
        throw new Error(quotaFailure);
    const aggregateWorktreeBytes = await directoryAllocatedBytes(worktree);
    if (aggregateWorktreeBytes > profile.worktreeMaxBytes) {
        throw new Error(`verification worktree exceeded ${profile.worktreeMaxBytes} byte ceiling (${aggregateWorktreeBytes})`);
    }
    return {
        ...result,
        sandbox: {
            bubblewrapSha256: bwrap.sha256,
            networkNamespace: "private_no_interfaces",
            worktreeMount: "writable",
            gitCommonMount: "read_only",
            hostHomeMounted: false,
            tmp: "tmpfs",
            resourceProfileId: profile.resourceProfileId,
            resourceProfileHash: profile.resourceProfileHash,
            cgroupEnforced: wrapped.cgroupEnforced,
            rlimitsEnforced: wrapped.rlimitsEnforced,
            aggregateWorktreeBytes,
        },
    };
}
//# sourceMappingURL=verification-sandbox.js.map