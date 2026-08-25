#!/usr/bin/env node

import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REGULAR_GIT_MODES = new Set(["100644", "100755"]);

function git(root, args, encoding = "utf8") {
  return spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitZero(buffer) {
  return Buffer.from(buffer).toString("utf8").split("\0").filter(Boolean);
}

function safeRelative(relative, label = "release path") {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0") || relative.includes("\\")
    || relative.startsWith("/") || /^[A-Za-z]:\//u.test(relative)) {
    throw new Error(`${label} is not a safe relative path: ${JSON.stringify(relative)}`);
  }
  const components = relative.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`${label} contains an unsafe component: ${JSON.stringify(relative)}`);
  }
  return components;
}

function forbiddenMetadata(relative) {
  const lower = safeRelative(relative).map((component) => component.toLowerCase());
  return {
    gitmodules: lower.includes(".gitmodules"),
    nestedGit: lower.includes(".git"),
  };
}

function parseIndexRecords(output, prefix = "") {
  const entries = [];
  for (const record of splitZero(output)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error(`malformed Git index record: ${JSON.stringify(record)}`);
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(record.slice(0, tab));
    if (!match) throw new Error(`malformed Git index metadata: ${JSON.stringify(record.slice(0, tab))}`);
    const relative = record.slice(tab + 1);
    const scoped = prefix && relative.startsWith(`${prefix}/`) ? relative.slice(prefix.length + 1) : relative;
    safeRelative(scoped, "Git index path");
    entries.push({ mode: match[1], objectId: match[2], stage: match[3], path: scoped });
  }
  return entries;
}

async function filesystemInventory(root, { allowRootGitDirectory, skipNodeModules }) {
  const entries = [];
  async function walk(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (name === "node_modules") {
        if (skipNodeModules) continue;
        throw new Error(`node_modules is forbidden in package scope: ${childRelative}`);
      }
      const metadata = forbiddenMetadata(childRelative);
      if (metadata.gitmodules) throw new Error(`.gitmodules is forbidden in release scope: ${childRelative}`);
      if (metadata.nestedGit) {
        if (allowRootGitDirectory && relative === "" && name === ".git") continue;
        throw new Error(`nested .git metadata is forbidden in release scope: ${childRelative}`);
      }
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`symlink is forbidden in release scope: ${childRelative}`);
      if (info.isDirectory()) await walk(target, childRelative);
      else if (info.isFile()) entries.push({ path: childRelative, mode: (info.mode & 0o111) === 0 ? "100644" : "100755" });
      else throw new Error(`unsupported filesystem entry in release scope: ${childRelative}`);
    }
  }
  await walk(root);
  return entries;
}

function assertIndexEntries(entries, label) {
  for (const entry of entries) {
    if (entry.stage !== "0") throw new Error(`${label} contains unmerged Git index stage ${entry.stage}: ${entry.path}`);
    if (entry.mode === "160000") throw new Error(`${label} contains forbidden mode-160000 gitlink: ${entry.path}`);
    if (entry.mode === "120000") throw new Error(`${label} contains forbidden tracked symlink: ${entry.path}`);
    if (!REGULAR_GIT_MODES.has(entry.mode)) throw new Error(`${label} contains unsupported Git mode ${entry.mode}: ${entry.path}`);
    if (forbiddenMetadata(entry.path).gitmodules) throw new Error(`${label} contains forbidden .gitmodules: ${entry.path}`);
  }
}

function repositoryIndex(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const topPath = path.resolve(String(top.stdout).trim());
  const relative = path.relative(topPath, root).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("release root resolves outside its Git repository");
  const args = ["ls-files", "-s", "-z"];
  if (relative) args.push("--", relative);
  const listed = git(topPath, args, null);
  if (listed.status !== 0) throw new Error(`unable to inspect release Git index: ${String(listed.stderr ?? "").trim()}`);
  return { top: topPath, relative, entries: parseIndexRecords(listed.stdout, relative) };
}

export async function auditActiveSourceStructure(rootCandidate) {
  const root = await realpath(path.resolve(rootCandidate));
  const index = repositoryIndex(root);
  if (!index) throw new Error("active source structure gate requires a Git-bound source tree");
  assertIndexEntries(index.entries, "active source");
  const files = await filesystemInventory(root, { allowRootGitDirectory: index.top === root, skipNodeModules: true });
  return {
    result: "PASS",
    scope: "ACTIVE_SOURCE",
    trackedEntryCount: index.entries.length,
    filesystemFileCount: files.length,
    gitlinkCount: 0,
    gitmodulesCount: 0,
    symlinkCount: 0,
  };
}

export async function auditPackageStructure(rootCandidate) {
  const root = await realpath(path.resolve(rootCandidate));
  const index = repositoryIndex(root);
  if (index) assertIndexEntries(index.entries, "package staging");
  const files = await filesystemInventory(root, { allowRootGitDirectory: index?.top === root, skipNodeModules: false });
  return {
    result: "PASS",
    scope: "PACKAGE_STAGING",
    trackedEntryCount: index?.entries.length ?? null,
    filesystemFileCount: files.length,
    gitlinkCount: 0,
    gitmodulesCount: 0,
    nestedGitMetadataCount: 0,
    symlinkCount: 0,
  };
}

export function auditArchiveManifestEntries(entries) {
  if (!Array.isArray(entries)) throw new Error("archive manifest entries must be an array");
  const seen = new Set();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("archive manifest entry must be an object");
    const relative = String(raw.path ?? "");
    const metadata = forbiddenMetadata(relative);
    if (metadata.gitmodules) throw new Error(`archive manifest contains forbidden .gitmodules: ${relative}`);
    if (metadata.nestedGit) throw new Error(`archive manifest contains forbidden nested .git metadata: ${relative}`);
    const mode = String(raw.mode ?? "");
    const type = String(raw.type ?? "file");
    if (mode === "160000" || type === "gitlink") throw new Error(`archive manifest contains forbidden gitlink: ${relative}`);
    if (mode === "120000" || type === "symlink") throw new Error(`archive manifest contains forbidden symlink: ${relative}`);
    if (!["100644", "100755", "040000"].includes(mode) || !["file", "directory"].includes(type)) {
      throw new Error(`archive manifest contains unsupported mode/type ${mode}/${type}: ${relative}`);
    }
    if (seen.has(relative)) throw new Error(`archive manifest contains a duplicate path: ${relative}`);
    seen.add(relative);
  }
  return {
    result: "PASS",
    scope: "ARCHIVE_MANIFEST",
    entryCount: entries.length,
    gitlinkCount: 0,
    gitmodulesCount: 0,
    nestedGitMetadataCount: 0,
    symlinkCount: 0,
    duplicateCount: 0,
  };
}
