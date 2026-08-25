#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT_MANIFEST_PATH = "MANIFEST_SHA256.txt";
export const ROOT_MANIFEST_FORMAT = "sha256--git-mode--utf8-path-v1";
export const ALLOWED_REGULAR_MODES = new Set(["100644", "100755"]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function displayBytes(value) {
  try {
    return JSON.stringify(utf8Decoder.decode(value));
  } catch {
    return `hex:${value.toString("hex")}`;
  }
}

function decodeUtf8(value, label) {
  try {
    return utf8Decoder.decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8 (${displayBytes(value)})`);
  }
}

export function validateSafePathBytes(pathBytes, label = "repository path") {
  if (!Buffer.isBuffer(pathBytes) || pathBytes.length === 0) {
    throw new Error(`${label} must be a non-empty byte string`);
  }
  if (pathBytes.includes(0)) throw new Error(`${label} contains NUL`);
  const relative = decodeUtf8(pathBytes, label);
  if (Buffer.compare(Buffer.from(relative, "utf8"), pathBytes) !== 0) {
    throw new Error(`${label} does not have a canonical UTF-8 byte representation`);
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(relative)) {
    throw new Error(`${label} contains a control or formatting character: ${JSON.stringify(relative)}`);
  }
  if (relative.includes("\\")) {
    throw new Error(`${label} contains a backslash that is unsafe in the line-oriented manifest: ${JSON.stringify(relative)}`);
  }
  if (relative.startsWith("/") || relative.endsWith("/") || relative.includes("//")) {
    throw new Error(`${label} is not a canonical repository-relative path: ${JSON.stringify(relative)}`);
  }
  const components = relative.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`${label} contains an unsafe path component: ${JSON.stringify(relative)}`);
  }
  return relative;
}

function runGit(root, args, { encoding } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? decodeUtf8(result.stderr, "Git stderr")
      : String(result.stderr ?? "");
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return result.stdout;
}

export async function resolveRepositoryRoot(candidate) {
  const requested = path.resolve(candidate ?? fileURLToPath(new URL("..", import.meta.url)));
  const resolved = await realpath(requested);
  const topOutput = runGit(resolved, ["rev-parse", "--show-toplevel"]);
  const topText = decodeUtf8(Buffer.from(topOutput), "Git repository root").replace(/\n$/u, "");
  const top = await realpath(topText);
  if (resolved !== top) {
    throw new Error(`root Manifest command requires the repository top level: requested=${JSON.stringify(resolved)} top=${JSON.stringify(top)}`);
  }
  return resolved;
}

function parseIndexRecord(record) {
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new Error(`malformed git ls-files record without TAB: ${displayBytes(record)}`);
  const metadataBytes = record.subarray(0, tab);
  const pathBytes = Buffer.from(record.subarray(tab + 1));
  const metadata = decodeUtf8(metadataBytes, "Git index metadata");
  const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(metadata);
  if (!match) throw new Error(`malformed git ls-files metadata: ${JSON.stringify(metadata)}`);
  const [, mode, objectId, stage] = match;
  const relative = validateSafePathBytes(pathBytes, "Git index path");
  if (stage !== "0") throw new Error(`unmerged Git index stage ${stage} is forbidden for ${JSON.stringify(relative)}`);
  if (!ALLOWED_REGULAR_MODES.has(mode)) {
    if (mode === "120000") throw new Error(`tracked symlink is forbidden: ${JSON.stringify(relative)}`);
    if (mode === "160000") throw new Error(`tracked gitlink/submodule is forbidden: ${JSON.stringify(relative)}`);
    throw new Error(`unsupported tracked mode ${mode} for ${JSON.stringify(relative)}`);
  }
  return { mode, objectId, stage, relative, pathBytes };
}

export function parseGitLsFiles(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("git ls-files output must be a Buffer");
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0, offset);
    if (nul < 0) throw new Error("git ls-files -z output is not NUL terminated");
    const record = buffer.subarray(offset, nul);
    if (record.length === 0) throw new Error("git ls-files -z output contains an empty record");
    entries.push(parseIndexRecord(record));
    offset = nul + 1;
  }
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (Buffer.compare(entries[index - 1].pathBytes, entries[index].pathBytes) === 0) {
      throw new Error(`duplicate Git index path: ${JSON.stringify(entries[index].relative)}`);
    }
  }
  return entries;
}

export async function readGitIndex(root) {
  const output = runGit(root, ["ls-files", "-s", "-z"]);
  const tracked = parseGitLsFiles(Buffer.from(output));
  const manifestEntries = tracked.filter((entry) => entry.relative === ROOT_MANIFEST_PATH);
  if (manifestEntries.length !== 1) {
    throw new Error(`root ${ROOT_MANIFEST_PATH} must be tracked exactly once; observed=${manifestEntries.length}`);
  }
  if (manifestEntries[0].mode !== "100644") {
    throw new Error(`root ${ROOT_MANIFEST_PATH} must have Git mode 100644`);
  }
  return {
    tracked,
    manifestIndexEntry: manifestEntries[0],
    covered: tracked.filter((entry) => entry.relative !== ROOT_MANIFEST_PATH),
  };
}

async function inspectPath(root, entry) {
  let target = root;
  const components = entry.relative.split("/");
  for (let index = 0; index < components.length; index += 1) {
    target = path.join(target, components[index]);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`tracked path is missing from the worktree: ${JSON.stringify(entry.relative)}`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`worktree symlink is forbidden: ${JSON.stringify(entry.relative)}`);
    }
    const final = index === components.length - 1;
    if (!final && !info.isDirectory()) {
      throw new Error(`tracked path parent is not a directory: ${JSON.stringify(entry.relative)}`);
    }
    if (final && !info.isFile()) {
      throw new Error(`tracked path is not a regular file: ${JSON.stringify(entry.relative)}`);
    }
  }
  return target;
}

function gitModeFromStat(info) {
  return (info.mode & 0o111) === 0 ? "100644" : "100755";
}

async function hashTrackedFile(root, entry, contentNeedle) {
  const target = await inspectPath(root, entry);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`tracked path is not a regular file: ${JSON.stringify(entry.relative)}`);
    const actualMode = gitModeFromStat(before);
    const hash = createHash("sha256");
    let containsNeedle = false;
    let overlap = Buffer.alloc(0);
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) {
      hash.update(chunk);
      if (contentNeedle && !containsNeedle) {
        const searchable = overlap.length > 0 ? Buffer.concat([overlap, chunk]) : chunk;
        containsNeedle = searchable.indexOf(contentNeedle) >= 0;
        const retained = Math.max(0, contentNeedle.length - 1);
        overlap = searchable.subarray(Math.max(0, searchable.length - retained));
      }
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`tracked file changed while it was being hashed: ${JSON.stringify(entry.relative)}`);
    }
    return { sha256: hash.digest("hex"), actualMode, containsNeedle };
  } finally {
    await handle.close();
  }
}

export function formatRootManifest(entries) {
  return Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.mode}  ${entry.relative}\n`).join(""), "utf8");
}

export function parseRootManifest(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("root Manifest must be read as bytes");
  const text = decodeUtf8(buffer, "root Manifest");
  if (text.length === 0 || !text.endsWith("\n")) throw new Error("root Manifest must be non-empty and end with exactly one LF-delimited record");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error("root Manifest contains an empty record");
  const entries = [];
  const firstByPath = new Map();
  let duplicateCount = 0;
  let selfReferenceCount = 0;
  let orderingMismatchCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^([0-9a-f]{64})  (100644|100755)  (.+)$/u.exec(line);
    if (!match) throw new Error(`root Manifest record ${index + 1} does not match ${ROOT_MANIFEST_FORMAT}`);
    const [, sha256, mode, relative] = match;
    const pathBytes = Buffer.from(relative, "utf8");
    validateSafePathBytes(pathBytes, `root Manifest path at record ${index + 1}`);
    const entry = { sha256, mode, relative, pathBytes, record: index + 1 };
    if (relative === ROOT_MANIFEST_PATH) selfReferenceCount += 1;
    if (firstByPath.has(relative)) duplicateCount += 1;
    else firstByPath.set(relative, entry);
    if (entries.length > 0 && Buffer.compare(entries.at(-1).pathBytes, pathBytes) >= 0) orderingMismatchCount += 1;
    entries.push(entry);
  }
  return { entries, firstByPath, duplicateCount, selfReferenceCount, orderingMismatchCount };
}

export async function updateRootManifest(rootCandidate) {
  const root = await resolveRepositoryRoot(rootCandidate);
  const index = await readGitIndex(root);
  const rootManifestState = await hashTrackedFile(root, index.manifestIndexEntry);
  if (rootManifestState.actualMode !== index.manifestIndexEntry.mode) {
    throw new Error(`root ${ROOT_MANIFEST_PATH} worktree executable mode differs from Git mode ${index.manifestIndexEntry.mode}`);
  }
  const entries = [];
  for (const entry of index.covered) {
    const state = await hashTrackedFile(root, entry);
    if (state.actualMode !== entry.mode) {
      throw new Error(`worktree executable mode differs from Git mode for ${JSON.stringify(entry.relative)}: index=${entry.mode} worktree=${state.actualMode}`);
    }
    entries.push({ ...entry, sha256: state.sha256 });
  }
  const output = formatRootManifest(entries);
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  const digestNeedle = Buffer.from(outputSha256, "ascii");
  for (const entry of entries) {
    const state = await hashTrackedFile(root, entry, digestNeedle);
    if (state.sha256 !== entry.sha256) {
      throw new Error(`tracked file changed between root Manifest passes: ${JSON.stringify(entry.relative)}`);
    }
    if (state.containsNeedle) {
      throw new Error(`covered file reverse-references the root Manifest digest: ${JSON.stringify(entry.relative)}`);
    }
  }
  const manifestTarget = path.join(root, ROOT_MANIFEST_PATH);
  const temporary = path.join(root, `.${ROOT_MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, output, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o644);
    await rename(temporary, manifestTarget);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    result: "PASS",
    format: ROOT_MANIFEST_FORMAT,
    trackedRegularFileCount: index.tracked.length,
    excludedPath: ROOT_MANIFEST_PATH,
    excludedCount: 1,
    manifestEntryCount: entries.length,
    outputBytes: output.length,
    manifestSha256: outputSha256,
  };
}

export async function verifyRootManifest(rootCandidate) {
  const root = await resolveRepositoryRoot(rootCandidate);
  const index = await readGitIndex(root);
  const manifestBytes = await readFile(path.join(root, ROOT_MANIFEST_PATH));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const digestNeedle = Buffer.from(manifestSha256, "ascii");
  const parsed = parseRootManifest(manifestBytes);
  const expectedByPath = new Map(index.covered.map((entry) => [entry.relative, entry]));
  const expectedPaths = new Set(expectedByPath.keys());
  const actualPaths = new Set(parsed.firstByPath.keys());
  const missingPaths = [...expectedPaths].filter((relative) => !actualPaths.has(relative)).sort();
  const extraPaths = [...actualPaths].filter((relative) => !expectedPaths.has(relative)).sort();
  const hashMismatchPaths = [];
  const modeMismatchPaths = [];
  const reverseReferencePaths = [];

  const rootManifestState = await hashTrackedFile(root, index.manifestIndexEntry);
  if (rootManifestState.actualMode !== index.manifestIndexEntry.mode) {
    modeMismatchPaths.push(ROOT_MANIFEST_PATH);
  }

  for (const entry of index.covered) {
    const state = await hashTrackedFile(root, entry, digestNeedle);
    const manifestEntry = parsed.firstByPath.get(entry.relative);
    if (state.actualMode !== entry.mode || (manifestEntry && manifestEntry.mode !== entry.mode)) {
      modeMismatchPaths.push(entry.relative);
    }
    if (manifestEntry && manifestEntry.sha256 !== state.sha256) hashMismatchPaths.push(entry.relative);
    if (state.containsNeedle) reverseReferencePaths.push(entry.relative);
  }

  const uniqueModeMismatchPaths = [...new Set(modeMismatchPaths)].sort();
  const result = {
    result: "FAIL",
    format: ROOT_MANIFEST_FORMAT,
    manifestSha256,
    trackedRegularFileCount: index.tracked.length,
    expectedEntryCount: index.covered.length,
    excludedPath: ROOT_MANIFEST_PATH,
    excludedCount: 1,
    manifestEntryCount: parsed.entries.length,
    uniqueManifestPathCount: parsed.firstByPath.size,
    mismatchCount: hashMismatchPaths.length,
    missingCount: missingPaths.length,
    extraCount: extraPaths.length,
    duplicateCount: parsed.duplicateCount,
    modeMismatchCount: uniqueModeMismatchPaths.length,
    selfReferenceCount: parsed.selfReferenceCount,
    orderingMismatchCount: parsed.orderingMismatchCount,
    reverseReferenceCount: reverseReferencePaths.length,
    mismatches: hashMismatchPaths,
    missing: missingPaths,
    extra: extraPaths,
    modeMismatches: uniqueModeMismatchPaths,
    reverseReferences: reverseReferencePaths,
  };
  if (result.mismatchCount === 0 && result.missingCount === 0 && result.extraCount === 0
    && result.duplicateCount === 0 && result.modeMismatchCount === 0
    && result.selfReferenceCount === 0 && result.orderingMismatchCount === 0
    && result.reverseReferenceCount === 0
    && result.manifestEntryCount === result.expectedEntryCount) {
    result.result = "PASS";
  }
  return result;
}
