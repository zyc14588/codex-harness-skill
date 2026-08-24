#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CANDIDATE_VERSION = "0.6.6-rc.1";
export const STABLE_VERSION = "0.6.6";

export const SOURCE_SCOPE = [
  ".agents",
  ".codex-plugin",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "bridge/package.json",
  "bridge/package-lock.json",
  "bridge/tsconfig.json",
  "bridge/src",
  "bridge/dist",
  "config",
  "docs",
  "harness",
  "schemas",
  "scripts",
  "skills",
];

export const CRITICAL_PATHS = [
  "bridge/src/security.ts",
  "bridge/src/monitor-daemon.ts",
  "bridge/src/harness-sandbox-entry.ts",
  "bridge/src/harness-isolation.ts",
  "bridge/src/brokered-tool-host.ts",
  "bridge/src/thinking-policy.ts",
  "bridge/src/minimal-request-state.ts",
  "bridge/src/provider-policy.ts",
  "bridge/src/worker.ts",
  "bridge/src/service.ts",
  "harness/minimal/preset/agent.cordis.yml.in",
  "harness/minimal/profile/bridge-brokered-tools.mjs",
  "harness/minimal/profile/bridge-headless-runner.mjs",
  "harness/minimal/profile/cordis.patch.yml",
];

// These are the only files that may be added or changed after the implementation
// commit. They carry qualification/seal metadata; executable source, generated
// runtime code, configuration, schemas, documentation, and tests remain byte-for-
// byte bound to the implementation commit through SOURCE_SCOPE.
export const ALLOWED_POST_IMPLEMENTATION_METADATA = [
  "MANIFEST_SHA256.txt",
  "SOURCE_PROVENANCE.json",
  "evidence/01_CURRENT_REVISION_LOCAL_QUALIFICATION.json",
  "evidence/02_CURRENT_REVISION_REAL_PROVIDER_REDACTED.json",
  "evidence/03_CURRENT_REVISION_NEGATIVE_SMOKE.json",
  "evidence/04_GITHUB_EXTERNAL_GATES_2026-08-24.json",
  "package-origin.json",
  "release-status.json",
].sort();

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function sha256File(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release input must be a regular non-symlink file: ${target}`);
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function collect(root, target, output) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`canonical source scope contains a symlink: ${path.relative(root, target)}`);
  if (info.isFile()) {
    output.push(path.relative(root, target).split(path.sep).join("/"));
    return;
  }
  if (!info.isDirectory()) throw new Error(`canonical source scope contains a non-file entry: ${path.relative(root, target)}`);
  for (const entry of await readdir(target)) await collect(root, path.join(target, entry), output);
}

export async function canonicalSourceBinding(root) {
  const canonicalRoot = await realpath(root);
  const files = [];
  for (const relative of SOURCE_SCOPE) {
    const target = path.resolve(canonicalRoot, relative);
    if (!inside(canonicalRoot, target)) throw new Error(`unsafe source scope path: ${relative}`);
    await collect(canonicalRoot, target, files);
  }
  files.sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    const target = path.join(canonicalRoot, relative);
    const info = await lstat(target);
    const data = await readFile(target);
    hash.update(relative).update("\0").update(String(info.mode & 0o777)).update("\0").update(String(data.length)).update("\0").update(data).update("\0");
  }
  return { algorithm: "sha256-path-mode-size-content-v1", sha256: hash.digest("hex"), files };
}

export async function criticalPathBinding(root) {
  const entries = {};
  for (const relative of CRITICAL_PATHS) entries[relative] = await sha256File(path.join(root, relative));
  const setSha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { entries, setSha256 };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitResult(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function gitIdentity(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  if (!top || !commit) return { available: false };
  const relative = path.relative(top, path.resolve(root)).split(path.sep).join("/");
  const sourceTree = relative ? git(root, ["rev-parse", `HEAD:${relative}`]) : git(root, ["rev-parse", "HEAD^{tree}"]);
  const repositoryTree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const committedAt = git(root, ["show", "-s", "--format=%cI", commit]);
  const sourcePathspec = SOURCE_SCOPE.map((entry) => relative ? `${relative}/${entry}` : entry);
  const sourceStatus = git(top, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...sourcePathspec]);
  const repositoryStatus = git(top, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    available: true,
    top,
    relative,
    commit,
    sourceTree,
    repositoryTree,
    committedAt,
    sourceClean: sourceStatus === "",
    repositoryClean: repositoryStatus === "",
    repositoryStatus,
  };
}

export function implementationScopeBinding(root, implementationCommit) {
  if (!/^[0-9a-f]{40,64}$/u.test(String(implementationCommit ?? ""))) {
    throw new Error("implementation commit binding is invalid");
  }
  const identity = gitIdentity(root);
  if (!identity.available) return { available: false };
  const ancestor = gitResult(root, ["merge-base", "--is-ancestor", implementationCommit, "HEAD"]);
  if (ancestor.status !== 0) throw new Error("implementation commit is not an ancestor of the release seal");
  const sourcePathspec = SOURCE_SCOPE.map((entry) => identity.relative ? `${identity.relative}/${entry}` : entry);
  const changed = gitResult(identity.top, [
    "diff",
    "--name-only",
    "--no-renames",
    `${implementationCommit}..HEAD`,
    "--",
    ...sourcePathspec,
  ]);
  if (changed.status !== 0) throw new Error(`unable to compare implementation source scope: ${changed.stderr.trim()}`);
  const changedPaths = changed.stdout.trim() ? changed.stdout.trim().split("\n") : [];
  const allSourceChanges = gitResult(identity.top, [
    "diff",
    "--name-only",
    "--no-renames",
    `${implementationCommit}..HEAD`,
    "--",
    identity.relative || ".",
  ]);
  if (allSourceChanges.status !== 0) throw new Error(`unable to compare post-implementation metadata: ${allSourceChanges.stderr.trim()}`);
  const prefix = identity.relative ? `${identity.relative}/` : "";
  const relativeChanges = (allSourceChanges.stdout.trim() ? allSourceChanges.stdout.trim().split("\n") : [])
    .map((entry) => prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry);
  const inImplementationScope = (candidate) => SOURCE_SCOPE.some((entry) => candidate === entry || candidate.startsWith(`${entry}/`));
  const metadataChanges = relativeChanges.filter((entry) => !inImplementationScope(entry));
  const unauthorizedMetadataChanges = metadataChanges.filter((entry) => !ALLOWED_POST_IMPLEMENTATION_METADATA.includes(entry));
  return {
    available: true,
    exact: changedPaths.length === 0,
    changedPaths,
    metadataChanges,
    allowedMetadataOnly: unauthorizedMetadataChanges.length === 0,
    unauthorizedMetadataChanges,
  };
}

export async function releaseIntegrity(root) {
  const source = await canonicalSourceBinding(root);
  const critical = await criticalPathBinding(root);
  return { schemaVersion: 1, source, critical, git: gitIdentity(root) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const rootIndex = process.argv.indexOf("--root");
  if (rootIndex < 0 || !process.argv[rootIndex + 1]) {
    process.stderr.write("Usage: release-integrity.mjs --root PATH\n");
    process.exitCode = 2;
  } else {
    releaseIntegrity(path.resolve(process.argv[rootIndex + 1])).then(
      (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
      (error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
    );
  }
}
