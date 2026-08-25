import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import type { TaskRecord } from "./types.js";
import { isWithin, leaseMatches, normalizeRepoRelative, pathExists, runProcess } from "./util.js";

const MAX_GIT_CAPTURE_CHARS = 10_000_000;
const MAX_PATCH_CHARS = 50_000_000;
const MAX_REVIEW_FILE_BYTES = 5_000_000;
export const MAX_REVIEW_PAGE_BYTES = 49_152;
const SAFE_GIT_CONFIG_ARGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "core.fsmonitor=false",
];

function safeGitArgs(args: string[]): string[] {
  return [...SAFE_GIT_CONFIG_ARGS, "-c", "core.quotepath=false", ...args];
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
  maxCaptureChars = MAX_GIT_CAPTURE_CHARS,
): Promise<string> {
  const result = await runProcess("git", safeGitArgs(args), { cwd, timeoutMs, maxCaptureChars, killProcessGroup: true });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
  if (result.stdoutTruncated) throw new Error(`git ${args.join(" ")} output exceeded ${maxCaptureChars} characters`);
  return result.stdout;
}

export async function gitTopLevel(repoRoot: string): Promise<string> {
  return path.resolve((await git(repoRoot, ["rev-parse", "--show-toplevel"])).trim());
}


export async function workingTreePaths(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
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



export async function unsafeChangedSymlinkPaths(worktreePath: string, paths: string[]): Promise<string[]> {
  const root = path.resolve(await realpath(worktreePath));
  const findings = new Set<string>();
  for (const filePath of paths) {
    const relative = normalizeRepoRelative(filePath);
    const absolute = path.resolve(root, relative);
    if (!isWithin(absolute, root)) throw new Error(`changed path escapes worktree: ${relative}`);
    let current = absolute;
    while (current !== root) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          findings.add(normalizeRepoRelative(path.relative(root, current)));
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...findings].sort();
}

async function pathsAtCommitMode(repoRoot: string, commit: string, targetMode: string): Promise<string[]> {
  const output = await git(repoRoot, ["ls-tree", "-r", "-z", commit]);
  const paths: string[] = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab);
    const filePath = entry.slice(tab + 1);
    const mode = metadata.split(/\s+/, 1)[0];
    if (mode === targetMode) paths.push(normalizeRepoRelative(filePath));
  }
  return [...new Set(paths)].sort();
}

export async function symlinkPathsAtCommit(repoRoot: string, commit: string): Promise<string[]> {
  return await pathsAtCommitMode(repoRoot, commit, "120000");
}

export async function gitlinkPathsAtCommit(repoRoot: string, commit: string): Promise<string[]> {
  return await pathsAtCommitMode(repoRoot, commit, "160000");
}

export async function environmentFilesAtCommit(repoRoot: string, commit: string): Promise<string[]> {
  const output = await git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit]);
  return splitNull(output).filter((filePath) => {
    const name = path.posix.basename(filePath);
    if (!/^\.env(?:\..+)?$/iu.test(name)) return false;
    return !/\.(?:dist|example|sample|template)$/iu.test(name);
  });
}

export async function gitlinkPathsInIndex(worktreePath: string): Promise<string[]> {
  const output = await git(worktreePath, ["ls-files", "--stage", "-z"]);
  const paths: string[] = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab);
    const filePath = entry.slice(tab + 1);
    const mode = metadata.split(/\s+/, 1)[0];
    if (mode === "160000") paths.push(normalizeRepoRelative(filePath));
  }
  return [...new Set(paths)].sort();
}

export async function unsafeChangedGitlinkPaths(worktreePath: string, paths: string[]): Promise<string[]> {
  const changed = paths.map(normalizeRepoRelative);
  const findings = new Set<string>();
  for (const gitlink of await gitlinkPathsInIndex(worktreePath)) {
    if (changed.some((filePath) => filePath === gitlink || filePath.startsWith(`${gitlink}/`))) findings.add(gitlink);
  }
  if (changed.includes(".gitmodules")) findings.add(".gitmodules");
  return [...findings].sort();
}

export async function textFileAtCommit(repoRoot: string, commit: string, filePath: string): Promise<string | undefined> {
  const relative = normalizeRepoRelative(filePath);
  const exists = await runProcess("git", safeGitArgs(["-C", repoRoot, "cat-file", "-e", `${commit}:${relative}`]), { timeoutMs: 10_000, killProcessGroup: true });
  if (exists.code !== 0) return undefined;
  const result = await runProcess("git", safeGitArgs(["-C", repoRoot, "show", `${commit}:${relative}`]), {
    timeoutMs: 30_000,
    maxCaptureChars: 1_000_000,
    killProcessGroup: true,
  });
  if (result.code !== 0) throw new Error(`cannot read ${relative} at ${commit}: ${result.stderr || result.stdout}`);
  if (result.stdoutTruncated) throw new Error(`${relative} at ${commit} exceeds the 1000000-character safety limit`);
  if (result.stdout.includes("\0")) throw new Error(`${relative} at ${commit} is not a text file`);
  return result.stdout;
}

export function findLeaseSymlinkIntersections(symlinks: string[], leases: string[]): string[] {
  const intersects = (symlink: string, lease: string): boolean => {
    if (lease === "**") return true;
    if (lease.endsWith("/**")) {
      const root = lease.slice(0, -3).replace(/\/$/, "");
      return symlink === root || symlink.startsWith(`${root}/`) || root.startsWith(`${symlink}/`);
    }
    return lease === symlink || lease.startsWith(`${symlink}/`);
  };
  return symlinks.filter((symlink) => leases.some((lease) => intersects(symlink, lease)));
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  return (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

export async function createWorktree(repoRoot: string, worktreePath: string, branchName: string, baseCommit: string): Promise<void> {
  await git(repoRoot, ["worktree", "add", "--no-checkout", "-b", branchName, worktreePath, baseCommit], 300_000);
  await git(worktreePath, ["checkout", "--force", branchName], 300_000);
}

export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<void> {
  if (!(await pathExists(worktreePath))) return;
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  await git(repoRoot, args, 300_000);
}

export async function deleteBranch(repoRoot: string, branchName: string, force: boolean): Promise<void> {
  const check = await runProcess("git", safeGitArgs(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]), { timeoutMs: 10_000, killProcessGroup: true });
  if (check.code !== 0) return;
  await git(repoRoot, ["branch", force ? "-D" : "-d", branchName], 120_000);
}

function splitNull(text: string): string[] {
  return text.split("\0").filter(Boolean).map(normalizeRepoRelative);
}

async function untrackedPaths(worktreePath: string): Promise<string[]> {
  return splitNull(await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

export async function ignoredUntrackedPaths(worktreePath: string): Promise<string[]> {
  return splitNull(await git(worktreePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
}

export async function changedPaths(worktreePath: string, baseCommit: string): Promise<string[]> {
  const worktree = splitNull(await git(worktreePath, ["diff", "--name-only", "-z", baseCommit, "--"]));
  const index = splitNull(await git(worktreePath, ["diff", "--cached", "--name-only", "-z", baseCommit, "--"]));
  const untracked = await untrackedPaths(worktreePath);
  return [...new Set([...worktree, ...index, ...untracked])].sort();
}

export function findOutOfScope(paths: string[], leases: string[]): string[] {
  return paths.filter((file) => !leases.some((lease) => leaseMatches(lease, file)));
}

export async function diffStat(worktreePath: string, baseCommit: string): Promise<string> {
  const tracked = await git(worktreePath, ["diff", "--stat", baseCommit, "--"]);
  const untracked = await untrackedPaths(worktreePath);
  const extra = untracked.map((file) => ` ?? ${file}`).join("\n");
  return [tracked.trimEnd(), extra].filter(Boolean).join("\n");
}

export async function stagedPaths(worktreePath: string): Promise<string[]> {
  return splitNull(await git(worktreePath, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]));
}

export async function binaryPatch(worktreePath: string, baseCommit: string): Promise<string> {
  const sections: string[] = [];
  const tracked = await git(worktreePath, ["diff", "--binary", "--full-index", baseCommit, "--"], 300_000, MAX_PATCH_CHARS);
  if (tracked) sections.push(tracked.trimEnd());
  for (const file of await untrackedPaths(worktreePath)) {
    const result = await runProcess("git", safeGitArgs([
      "diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", file,
    ]), { cwd: worktreePath, timeoutMs: 300_000, maxCaptureChars: MAX_PATCH_CHARS, killProcessGroup: true });
    if (result.code !== 1 || !result.stdout || result.stdoutTruncated) {
      throw new Error(`cannot encode untracked file in canonical reviewed patch: ${file}: ${result.stderr || result.stdout}`);
    }
    sections.push(result.stdout.trimEnd());
    const currentSize = sections.reduce((total, section) => total + section.length + 1, 0);
    if (currentSize > MAX_PATCH_CHARS) throw new Error(`combined patch exceeds ${MAX_PATCH_CHARS} characters`);
  }
  return sections.length ? `${sections.join("\n")}\n` : "";
}

export async function createDetachedVerificationWorktree(repoRoot: string, worktreePath: string, baseCommit: string): Promise<void> {
  await git(repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit], 300_000);
}

export async function cleanWorktreeIncludingIgnored(worktreePath: string): Promise<void> {
  await git(worktreePath, ["clean", "-ffdx"], 300_000);
  const residue = await ignoredUntrackedPaths(worktreePath);
  if (residue.length) throw new Error(`verification worktree retains ignored residue after git clean -ffdx: ${residue.join(", ")}`);
}

export async function applyReviewedPatch(worktreePath: string, patchPath: string): Promise<void> {
  await git(worktreePath, ["apply", "--check", "--binary", patchPath], 300_000, MAX_PATCH_CHARS);
  await git(worktreePath, ["apply", "--binary", "--whitespace=nowarn", patchPath], 300_000, MAX_PATCH_CHARS);
}

export async function commitLog(worktreePath: string, baseCommit: string): Promise<string> {
  return await git(worktreePath, ["log", "--oneline", "--decorate", `${baseCommit}..HEAD`]);
}

export interface ReviewFilePage {
  content: string;
  source: "worktree" | "base_commit_deleted";
  fileSha256: string;
  totalBytes: number;
  requestedOffsetBytes: number;
  offsetBytes: number;
  returnedBytes: number;
  nextOffsetBytes: number | null;
}

export async function readRepoFile(
  worktreePath: string,
  filePath: string,
  baseCommit: string,
  requestedOffsetBytes = 0,
  requestedMaxBytes = MAX_REVIEW_PAGE_BYTES,
): Promise<ReviewFilePage> {
  const relative = normalizeRepoRelative(filePath);
  const absolute = path.resolve(worktreePath, relative);
  const root = await realpath(worktreePath);
  if (!isWithin(absolute, root)) throw new Error("path escapes worktree");
  if (!Number.isSafeInteger(requestedOffsetBytes) || requestedOffsetBytes < 0) throw new Error("offsetBytes must be a non-negative integer");
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 256 || requestedMaxBytes > MAX_REVIEW_PAGE_BYTES) {
    throw new Error(`maxBytes must be an integer from 256 to ${MAX_REVIEW_PAGE_BYTES}`);
  }
  let data: Buffer;
  let source: ReviewFilePage["source"] = "worktree";
  if (await pathExists(absolute)) {
    const resolved = await realpath(absolute);
    if (!isWithin(resolved, root)) throw new Error(`${relative} resolves outside the worktree`);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`${relative} is not a regular file`);
    if (info.size > MAX_REVIEW_FILE_BYTES) throw new Error(`${relative} exceeds the ${MAX_REVIEW_FILE_BYTES}-byte review limit`);
    data = await readFile(resolved);
  } else {
    source = "base_commit_deleted";
    const deleted = await git(worktreePath, ["show", `${baseCommit}:${relative}`], 30_000, MAX_REVIEW_FILE_BYTES + 1);
    data = Buffer.from(deleted, "utf8");
    if (data.length > MAX_REVIEW_FILE_BYTES) throw new Error(`${relative} base version exceeds the ${MAX_REVIEW_FILE_BYTES}-byte review limit`);
  }
  if (data.includes(0)) throw new Error(`${relative} appears to be binary`);
  let start = Math.min(requestedOffsetBytes, data.length);
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(data.length, start + requestedMaxBytes);
  while (end > start && end < data.length && (data[end]! & 0xc0) === 0x80) end -= 1;
  const selected = data.subarray(start, end);
  return {
    content: selected.toString("utf8"),
    source,
    fileSha256: createHash("sha256").update(data).digest("hex"),
    totalBytes: data.length,
    requestedOffsetBytes,
    offsetBytes: start,
    returnedBytes: selected.length,
    nextOffsetBytes: end < data.length ? end : null,
  };
}

export async function createCommit(worktreePath: string, message: string): Promise<{ commit: string; created: boolean }> {
  try {
    await git(worktreePath, ["add", "-A"]);
    const staged = (await git(worktreePath, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return { commit: (await git(worktreePath, ["rev-parse", "HEAD"])).trim(), created: false };
    await git(worktreePath, ["commit", "-m", message], 300_000);
    return { commit: (await git(worktreePath, ["rev-parse", "HEAD"])).trim(), created: true };
  } catch (error) {
    // The precondition for bridge commits is an empty index. Restore that state if
    // `git add` or a commit hook/signing policy fails, while preserving worktree edits.
    const reset = await runProcess("git", safeGitArgs(["-C", worktreePath, "reset", "--mixed", "HEAD"]), {
      timeoutMs: 120_000,
      maxCaptureChars: MAX_GIT_CAPTURE_CHARS,
    });
    if (reset.code !== 0) {
      throw new Error(`bridge commit failed and the Git index could not be restored: ${error instanceof Error ? error.message : String(error)}; reset error: ${reset.stderr || reset.stdout}`);
    }
    throw error;
  }
}

export async function assertTaskWorktreeIdentity(task: TaskRecord): Promise<void> {
  if (!(await pathExists(task.worktreePath))) throw new Error(`task worktree is missing: ${task.worktreePath}`);
  const top = await gitTopLevel(task.worktreePath);
  if (path.resolve(top) !== path.resolve(task.worktreePath)) {
    throw new Error(`worktree identity mismatch: expected ${task.worktreePath}, got ${top}`);
  }
  const branch = (await git(task.worktreePath, ["branch", "--show-current"])).trim();
  if (branch !== task.branchName) throw new Error(`branch identity mismatch: expected ${task.branchName}, got ${branch || "DETACHED"}`);
  const ancestor = await runProcess("git", safeGitArgs(["-C", task.worktreePath, "merge-base", "--is-ancestor", task.baseCommit, "HEAD"]), { timeoutMs: 10_000, killProcessGroup: true });
  if (ancestor.code !== 0) throw new Error(`base commit ${task.baseCommit} is not an ancestor of task HEAD`);
}
