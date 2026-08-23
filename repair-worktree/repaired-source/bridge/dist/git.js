import path from "node:path";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isWithin, leaseMatches, normalizeRepoRelative, pathExists, runProcess } from "./util.js";
const MAX_GIT_CAPTURE_CHARS = 10_000_000;
const MAX_PATCH_CHARS = 50_000_000;
const MAX_REVIEW_FILE_BYTES = 5_000_000;
async function git(cwd, args, timeoutMs = 120_000, maxCaptureChars = MAX_GIT_CAPTURE_CHARS) {
    const result = await runProcess("git", ["-c", "core.quotepath=false", ...args], { cwd, timeoutMs, maxCaptureChars, killProcessGroup: true });
    if (result.code !== 0)
        throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
    if (result.stdoutTruncated)
        throw new Error(`git ${args.join(" ")} output exceeded ${maxCaptureChars} characters`);
    return result.stdout;
}
export async function gitTopLevel(repoRoot) {
    return path.resolve((await git(repoRoot, ["rev-parse", "--show-toplevel"])).trim());
}
export async function workingTreePaths(repoRoot) {
    const output = await git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = output.split("\0").filter(Boolean);
    const paths = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] ?? "";
        if (entry.length < 4)
            continue;
        const status = entry.slice(0, 2);
        const firstPath = entry.slice(3);
        if (status.includes("R") || status.includes("C")) {
            const secondPath = entries[index + 1];
            if (secondPath) {
                paths.push(normalizeRepoRelative(secondPath));
                index += 1;
                continue;
            }
        }
        paths.push(normalizeRepoRelative(firstPath));
    }
    return [...new Set(paths)].sort();
}
export async function unsafeChangedSymlinkPaths(worktreePath, paths) {
    const root = path.resolve(await realpath(worktreePath));
    const findings = new Set();
    for (const filePath of paths) {
        const relative = normalizeRepoRelative(filePath);
        const absolute = path.resolve(root, relative);
        if (!isWithin(absolute, root))
            throw new Error(`changed path escapes worktree: ${relative}`);
        let current = absolute;
        while (current !== root) {
            try {
                const info = await lstat(current);
                if (info.isSymbolicLink()) {
                    findings.add(normalizeRepoRelative(path.relative(root, current)));
                    break;
                }
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    return [...findings].sort();
}
async function pathsAtCommitMode(repoRoot, commit, targetMode) {
    const output = await git(repoRoot, ["ls-tree", "-r", "-z", commit]);
    const paths = [];
    for (const entry of output.split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        if (tab < 0)
            continue;
        const metadata = entry.slice(0, tab);
        const filePath = entry.slice(tab + 1);
        const mode = metadata.split(/\s+/, 1)[0];
        if (mode === targetMode)
            paths.push(normalizeRepoRelative(filePath));
    }
    return [...new Set(paths)].sort();
}
export async function symlinkPathsAtCommit(repoRoot, commit) {
    return await pathsAtCommitMode(repoRoot, commit, "120000");
}
export async function gitlinkPathsAtCommit(repoRoot, commit) {
    return await pathsAtCommitMode(repoRoot, commit, "160000");
}
export async function environmentFilesAtCommit(repoRoot, commit) {
    const output = await git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit]);
    return splitNull(output).filter((filePath) => {
        const name = path.posix.basename(filePath);
        if (!/^\.env(?:\..+)?$/iu.test(name))
            return false;
        return !/\.(?:dist|example|sample|template)$/iu.test(name);
    });
}
export async function gitlinkPathsInIndex(worktreePath) {
    const output = await git(worktreePath, ["ls-files", "--stage", "-z"]);
    const paths = [];
    for (const entry of output.split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        if (tab < 0)
            continue;
        const metadata = entry.slice(0, tab);
        const filePath = entry.slice(tab + 1);
        const mode = metadata.split(/\s+/, 1)[0];
        if (mode === "160000")
            paths.push(normalizeRepoRelative(filePath));
    }
    return [...new Set(paths)].sort();
}
export async function unsafeChangedGitlinkPaths(worktreePath, paths) {
    const changed = paths.map(normalizeRepoRelative);
    const findings = new Set();
    for (const gitlink of await gitlinkPathsInIndex(worktreePath)) {
        if (changed.some((filePath) => filePath === gitlink || filePath.startsWith(`${gitlink}/`)))
            findings.add(gitlink);
    }
    if (changed.includes(".gitmodules"))
        findings.add(".gitmodules");
    return [...findings].sort();
}
export async function textFileAtCommit(repoRoot, commit, filePath) {
    const relative = normalizeRepoRelative(filePath);
    const exists = await runProcess("git", ["-C", repoRoot, "cat-file", "-e", `${commit}:${relative}`], { timeoutMs: 10_000, killProcessGroup: true });
    if (exists.code !== 0)
        return undefined;
    const result = await runProcess("git", ["-C", repoRoot, "show", `${commit}:${relative}`], {
        timeoutMs: 30_000,
        maxCaptureChars: 1_000_000,
        killProcessGroup: true,
    });
    if (result.code !== 0)
        throw new Error(`cannot read ${relative} at ${commit}: ${result.stderr || result.stdout}`);
    if (result.stdoutTruncated)
        throw new Error(`${relative} at ${commit} exceeds the 1000000-character safety limit`);
    if (result.stdout.includes("\0"))
        throw new Error(`${relative} at ${commit} is not a text file`);
    return result.stdout;
}
export function findLeaseSymlinkIntersections(symlinks, leases) {
    const intersects = (symlink, lease) => {
        if (lease === "**")
            return true;
        if (lease.endsWith("/**")) {
            const root = lease.slice(0, -3).replace(/\/$/, "");
            return symlink === root || symlink.startsWith(`${root}/`) || root.startsWith(`${symlink}/`);
        }
        return lease === symlink || lease.startsWith(`${symlink}/`);
    };
    return symlinks.filter((symlink) => leases.some((lease) => intersects(symlink, lease)));
}
export async function resolveCommit(repoRoot, ref) {
    return (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}
export async function createWorktree(repoRoot, worktreePath, branchName, baseCommit) {
    await git(repoRoot, ["worktree", "add", "--no-checkout", "-b", branchName, worktreePath, baseCommit], 300_000);
    await git(worktreePath, ["checkout", "--force", branchName], 300_000);
}
export async function removeWorktree(repoRoot, worktreePath, force) {
    if (!(await pathExists(worktreePath)))
        return;
    const args = ["worktree", "remove"];
    if (force)
        args.push("--force");
    args.push(worktreePath);
    await git(repoRoot, args, 300_000);
}
export async function deleteBranch(repoRoot, branchName, force) {
    const check = await runProcess("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { timeoutMs: 10_000, killProcessGroup: true });
    if (check.code !== 0)
        return;
    await git(repoRoot, ["branch", force ? "-D" : "-d", branchName], 120_000);
}
function splitNull(text) {
    return text.split("\0").filter(Boolean).map(normalizeRepoRelative);
}
async function untrackedPaths(worktreePath) {
    return splitNull(await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]));
}
export async function changedPaths(worktreePath, baseCommit) {
    const worktree = splitNull(await git(worktreePath, ["diff", "--name-only", "-z", baseCommit, "--"]));
    const index = splitNull(await git(worktreePath, ["diff", "--cached", "--name-only", "-z", baseCommit, "--"]));
    const untracked = await untrackedPaths(worktreePath);
    return [...new Set([...worktree, ...index, ...untracked])].sort();
}
export function findOutOfScope(paths, leases) {
    return paths.filter((file) => !leases.some((lease) => leaseMatches(lease, file)));
}
export async function diffStat(worktreePath, baseCommit) {
    const tracked = await git(worktreePath, ["diff", "--stat", baseCommit, "--"]);
    const untracked = await untrackedPaths(worktreePath);
    const extra = untracked.map((file) => ` ?? ${file}`).join("\n");
    return [tracked.trimEnd(), extra].filter(Boolean).join("\n");
}
export async function stagedPaths(worktreePath) {
    return splitNull(await git(worktreePath, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]));
}
function patchPathLabel(file) {
    // JSON quoting makes control characters and unusual filenames unambiguous in
    // the review artifact without depending on Git's locale/quotepath settings.
    return JSON.stringify(file);
}
async function renderUntrackedFilePatch(worktreePath, file) {
    const relative = normalizeRepoRelative(file);
    const absolute = path.resolve(worktreePath, relative);
    const root = path.resolve(await realpath(worktreePath));
    if (!isWithin(absolute, root))
        throw new Error(`untracked path escapes worktree: ${relative}`);
    const info = await lstat(absolute);
    const label = patchPathLabel(relative);
    if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        return [
            `diff --codex-harness-untracked ${label}`,
            `new file mode 120000`,
            `path ${label}`,
            `size ${Buffer.byteLength(target, "utf8")}`,
            `sha256 ${createHash("sha256").update(target, "utf8").digest("hex")}`,
            `content-encoding symlink-target`,
            target,
        ].join("\n");
    }
    if (!info.isFile())
        throw new Error(`untracked path is not a regular file or symlink: ${relative}`);
    if (info.size > MAX_PATCH_CHARS)
        throw new Error(`untracked file ${relative} exceeds patch safety limit`);
    const data = await readFile(absolute);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
    let text;
    if (!data.includes(0)) {
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        }
        catch { /* deterministic binary summary below */ }
    }
    const header = [
        `diff --codex-harness-untracked ${label}`,
        `new file mode ${mode}`,
        `path ${label}`,
        `size ${data.length}`,
        `sha256 ${sha256}`,
    ];
    if (text === undefined)
        return [...header, "content-encoding binary-sha256-only"].join("\n");
    return [...header, "content-encoding utf-8", "--- content ---", text].join("\n");
}
export async function binaryPatch(worktreePath, baseCommit) {
    const sections = [];
    const tracked = await git(worktreePath, ["diff", "--binary", "--full-index", baseCommit, "--"], 300_000, MAX_PATCH_CHARS);
    if (tracked)
        sections.push(tracked.trimEnd());
    for (const file of await untrackedPaths(worktreePath)) {
        sections.push(await renderUntrackedFilePatch(worktreePath, file));
        const currentSize = sections.reduce((total, section) => total + section.length + 1, 0);
        if (currentSize > MAX_PATCH_CHARS)
            throw new Error(`combined patch exceeds ${MAX_PATCH_CHARS} characters`);
    }
    return sections.length ? `${sections.join("\n")}\n` : "";
}
export async function commitLog(worktreePath, baseCommit) {
    return await git(worktreePath, ["log", "--oneline", "--decorate", `${baseCommit}..HEAD`]);
}
export async function readRepoFile(worktreePath, filePath) {
    const relative = normalizeRepoRelative(filePath);
    const absolute = path.resolve(worktreePath, relative);
    const root = await realpath(worktreePath);
    if (!isWithin(absolute, root))
        throw new Error("path escapes worktree");
    const resolved = await realpath(absolute);
    if (!isWithin(resolved, root))
        throw new Error(`${relative} resolves outside the worktree`);
    const info = await stat(resolved);
    if (!info.isFile())
        throw new Error(`${relative} is not a regular file`);
    if (info.size > MAX_REVIEW_FILE_BYTES)
        throw new Error(`${relative} exceeds the ${MAX_REVIEW_FILE_BYTES}-byte review limit`);
    const data = await readFile(resolved);
    if (data.includes(0))
        throw new Error(`${relative} appears to be binary`);
    const lines = data.toString("utf8").split(/\r?\n/);
    const capped = lines.slice(0, 2000).join("\n");
    return lines.length > 2000 ? `${capped}\n\n[FILE TRUNCATED: ${lines.length - 2000} lines omitted]\n` : capped;
}
export async function createCommit(worktreePath, message) {
    try {
        await git(worktreePath, ["add", "-A"]);
        const staged = (await git(worktreePath, ["diff", "--cached", "--name-only"])).trim();
        if (!staged)
            return { commit: (await git(worktreePath, ["rev-parse", "HEAD"])).trim(), created: false };
        await git(worktreePath, ["commit", "-m", message], 300_000);
        return { commit: (await git(worktreePath, ["rev-parse", "HEAD"])).trim(), created: true };
    }
    catch (error) {
        // The precondition for bridge commits is an empty index. Restore that state if
        // `git add` or a commit hook/signing policy fails, while preserving worktree edits.
        const reset = await runProcess("git", ["-C", worktreePath, "reset", "--mixed", "HEAD"], {
            timeoutMs: 120_000,
            maxCaptureChars: MAX_GIT_CAPTURE_CHARS,
        });
        if (reset.code !== 0) {
            throw new Error(`bridge commit failed and the Git index could not be restored: ${error instanceof Error ? error.message : String(error)}; reset error: ${reset.stderr || reset.stdout}`);
        }
        throw error;
    }
}
export async function assertTaskWorktreeIdentity(task) {
    if (!(await pathExists(task.worktreePath)))
        throw new Error(`task worktree is missing: ${task.worktreePath}`);
    const top = await gitTopLevel(task.worktreePath);
    if (path.resolve(top) !== path.resolve(task.worktreePath)) {
        throw new Error(`worktree identity mismatch: expected ${task.worktreePath}, got ${top}`);
    }
    const branch = (await git(task.worktreePath, ["branch", "--show-current"])).trim();
    if (branch !== task.branchName)
        throw new Error(`branch identity mismatch: expected ${task.branchName}, got ${branch || "DETACHED"}`);
    const ancestor = await runProcess("git", ["-C", task.worktreePath, "merge-base", "--is-ancestor", task.baseCommit, "HEAD"], { timeoutMs: 10_000, killProcessGroup: true });
    if (ancestor.code !== 0)
        throw new Error(`base commit ${task.baseCommit} is not an ancestor of task HEAD`);
}
//# sourceMappingURL=git.js.map