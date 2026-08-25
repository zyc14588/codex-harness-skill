#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MANIFEST = "MANIFEST_SHA256.txt";
const excludedDirectories = new Set([".git", "node_modules"]);
const excludedFiles = new Set([".DS_Store"]);

function parseArgs(argv) {
  let root = path.resolve(new URL("..", import.meta.url).pathname);
  let requireGitExact = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) root = path.resolve(argv[++index]);
    else if (argv[index] === "--require-git-exact") requireGitExact = true;
    else throw new Error("Usage: verify-manifest.mjs [--root PATH] [--require-git-exact]");
  }
  return { root, requireGitExact };
}

function safePath(relative, label) {
  if (!relative || relative.includes("\\") || relative.startsWith("/") || /[\r\n\0]/u.test(relative)
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} is unsafe: ${JSON.stringify(relative)}`);
  }
}

async function inventory(root) {
  const files = new Map();
  async function walk(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      if (excludedFiles.has(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      safePath(child, "package path");
      if (child === MANIFEST) continue;
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`package symlink is forbidden: ${child}`);
      if (info.isDirectory()) {
        if (!excludedDirectories.has(name)) await walk(target, child);
      } else if (info.isFile()) {
        const bytes = await readFile(target);
        files.set(child, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
        });
      } else throw new Error(`unsupported package entry: ${child}`);
    }
  }
  await walk(root);
  return files;
}

function gitIndex(root) {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const topPath = path.resolve(top.stdout.trim());
  const relativeRoot = path.relative(topPath, root).split(path.sep).join("/");
  const args = ["-C", topPath, "ls-files", "-s", "-z"];
  if (relativeRoot) args.push("--", relativeRoot);
  const listed = spawnSync("git", args, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`unable to read Git index: ${String(listed.stderr ?? "").trim()}`);
  const entries = new Map();
  for (const record of Buffer.from(listed.stdout).toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const match = /^(\d{6}) [0-9a-f]{40,64} ([0-3])$/u.exec(record.slice(0, tab));
    if (!match || match[2] !== "0") throw new Error(`unsupported Git index record: ${JSON.stringify(record)}`);
    const repositoryPath = record.slice(tab + 1);
    const relative = relativeRoot && repositoryPath.startsWith(`${relativeRoot}/`)
      ? repositoryPath.slice(relativeRoot.length + 1)
      : repositoryPath;
    safePath(relative, "Git index path");
    if (!["100644", "100755"].includes(match[1])) throw new Error(`unsupported Git mode ${match[1]}: ${relative}`);
    entries.set(relative, match[1]);
  }
  return entries;
}

function parseManifest(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("current Manifest must end with LF");
  const entries = [];
  const first = new Map();
  let duplicateCount = 0;
  let selfReferenceCount = 0;
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error(`malformed current Manifest record ${index + 1}`);
    safePath(match[2], `current Manifest record ${index + 1}`);
    if (match[2] === MANIFEST) selfReferenceCount += 1;
    if (first.has(match[2])) duplicateCount += 1;
    else first.set(match[2], { sha256: match[1] });
    entries.push({ sha256: match[1], path: match[2] });
  }
  return { entries, first, duplicateCount, selfReferenceCount };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const root = await realpath(options.root);
  const actual = await inventory(root);
  const parsed = parseManifest(await readFile(path.join(root, MANIFEST)));
  const index = gitIndex(root);
  if (options.requireGitExact && !index) throw new Error("--require-git-exact requires a Git-bound current tree");
  const expectedPaths = options.requireGitExact
    ? new Set([...index.keys()].filter((entry) => entry !== MANIFEST))
    : new Set(actual.keys());
  const manifestPaths = new Set(parsed.first.keys());
  const missing = [...expectedPaths].filter((entry) => !manifestPaths.has(entry)).sort();
  const extra = [...manifestPaths].filter((entry) => !expectedPaths.has(entry)).sort();
  const mismatches = [...manifestPaths].filter((entry) => actual.has(entry) && parsed.first.get(entry).sha256 !== actual.get(entry).sha256).sort();
  const modeMismatches = index
    ? [...actual].filter(([entry, value]) => index.has(entry) && index.get(entry) !== value.mode).map(([entry]) => entry).sort()
    : [];
  const result = {
    result: "FAIL",
    format: "sha256--utf8-path-v1",
    trackedRegularFileCount: index?.size ?? null,
    expectedEntryCount: expectedPaths.size,
    manifestEntryCount: parsed.entries.length,
    uniqueManifestPathCount: parsed.first.size,
    mismatchCount: mismatches.length,
    missingCount: missing.length,
    extraCount: extra.length,
    duplicateCount: parsed.duplicateCount,
    modeMismatchCount: modeMismatches.length,
    selfReferenceCount: parsed.selfReferenceCount,
    mismatches,
    missing,
    extra,
    modeMismatches,
  };
  if (result.manifestEntryCount === result.expectedEntryCount && result.mismatchCount === 0
    && result.missingCount === 0 && result.extraCount === 0 && result.duplicateCount === 0
    && result.modeMismatchCount === 0 && result.selfReferenceCount === 0) result.result = "PASS";
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (result.result === "PASS") process.stdout.write(output);
  else { process.stderr.write(output); process.exitCode = 1; }
} catch (error) {
  process.stderr.write(`current Manifest verification FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
