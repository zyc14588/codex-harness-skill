#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PUBLIC_REF_PATTERN = /^refs\/(?:heads|tags)\/.+/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_ENVIRONMENT_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sanitizedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of GIT_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

export function runIsolatedGit(root, args, options = {}) {
  const command = [
    "--no-replace-objects",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "protocol.file.allow=always",
    "-c", "fetch.fsckObjects=true",
    "-c", "transfer.fsckObjects=true",
    "-C", root,
    ...args,
  ];
  const result = spawnSync("git", command, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? 128_000_000,
    env: sanitizedGitEnvironment(),
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`isolated git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function validateRefName(repositoryRoot, name) {
  if (!PUBLIC_REF_PATTERN.test(name) || name.startsWith("refs/pull/") || name === "refs/stash") {
    throw new Error(`non-public ref in remote advertisement: ${name}`);
  }
  const check = runIsolatedGit(repositoryRoot, ["check-ref-format", name], { allowFailure: true });
  if (check.status !== 0) throw new Error(`invalid public ref name in remote advertisement: ${name}`);
}

export function parsePublicRefAdvertisement(repositoryRoot, advertisement) {
  const records = new Map();
  const peeled = new Map();
  for (const line of String(advertisement).split(/\r?\n/u).filter(Boolean)) {
    const fields = line.split("\t");
    if (fields.length !== 2 || !OID_PATTERN.test(fields[0])) {
      throw new Error("malformed git ls-remote public-ref advertisement");
    }
    const oid = fields[0];
    const advertisedName = fields[1];
    if (advertisedName.endsWith("^{}")) {
      const name = advertisedName.slice(0, -3);
      validateRefName(repositoryRoot, name);
      if (!name.startsWith("refs/tags/")) throw new Error(`peeled non-tag ref in remote advertisement: ${name}`);
      if (peeled.has(name) && peeled.get(name) !== oid) throw new Error(`conflicting peeled OIDs for ${name}`);
      peeled.set(name, oid);
      continue;
    }
    validateRefName(repositoryRoot, advertisedName);
    if (records.has(advertisedName) && records.get(advertisedName) !== oid) {
      throw new Error(`conflicting advertised OIDs for ${advertisedName}`);
    }
    records.set(advertisedName, oid);
  }
  for (const name of peeled.keys()) {
    if (!records.has(name)) throw new Error(`peeled tag has no tag object advertisement: ${name}`);
  }
  const refs = [...records.entries()].map(([name, oid]) => ({
    name,
    oid,
    ...(peeled.has(name) ? { peeledOid: peeled.get(name) } : {}),
  })).sort((left, right) => compareUtf8(left.name, right.name));
  if (refs.length === 0) throw new Error("origin advertises no public heads or tags");
  return refs;
}

function normalizeRemoteUrl(repositoryRoot, remoteUrl) {
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(remoteUrl);
  if (scp && !/^[A-Za-z]:[\\/]/u.test(remoteUrl)) {
    const host = scp[1].toLowerCase();
    const repositoryPath = scp[2].replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    return {
      fetchUrl: remoteUrl,
      remoteIdentity: `${host}/${repositoryPath}`,
      repository: repositoryPath,
    };
  }
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.protocol !== "file:") {
      const repositoryPath = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
      return {
        fetchUrl: remoteUrl,
        remoteIdentity: `${parsed.hostname.toLowerCase()}/${repositoryPath}`,
        repository: repositoryPath,
      };
    }
    const localPath = realpathSync(decodeURIComponent(parsed.pathname));
    return {
      fetchUrl: `file://${localPath}`,
      remoteIdentity: `file://${localPath}`,
      repository: path.basename(localPath).replace(/\.git$/u, ""),
    };
  } catch {
    const localPath = realpathSync(path.resolve(repositoryRoot, remoteUrl));
    return {
      fetchUrl: localPath,
      remoteIdentity: `file://${localPath}`,
      repository: path.basename(localPath).replace(/\.git$/u, ""),
    };
  }
}

function canonicalRefSet(scope) {
  return JSON.stringify({
    schemaVersion: scope.schemaVersion,
    remoteIdentity: scope.remoteIdentity,
    repository: scope.repository,
    refs: scope.refs,
  });
}

export function computePublicRefSetSha256(scope) {
  return sha256(Buffer.from(canonicalRefSet(scope), "utf8"));
}

function verifyAdvertisedRefs(auditRepository, refs) {
  for (const ref of refs) {
    const actual = String(runIsolatedGit(auditRepository, ["rev-parse", "--verify", ref.name])).trim();
    if (actual !== ref.oid) {
      throw new Error(`origin ref changed or ls-remote input was forged for ${ref.name}: advertised=${ref.oid} fetched=${actual}`);
    }
    const type = String(runIsolatedGit(auditRepository, ["cat-file", "-t", ref.oid])).trim();
    if (ref.name.startsWith("refs/heads/") && type !== "commit") {
      throw new Error(`public head does not resolve to a commit: ${ref.name}`);
    }
    if (ref.peeledOid) {
      if (type !== "tag") throw new Error(`peeled advertisement is not an annotated tag: ${ref.name}`);
      const peeledCommit = String(runIsolatedGit(auditRepository, ["rev-parse", "--verify", `${ref.name}^{commit}`])).trim();
      if (peeledCommit !== ref.peeledOid) {
        throw new Error(`annotated tag peeled commit mismatch for ${ref.name}`);
      }
    } else if (ref.name.startsWith("refs/tags/") && type === "tag") {
      throw new Error(`annotated tag is missing its peeled advertisement: ${ref.name}`);
    }
  }
}

function verifyObjectClosure(auditRepository, refNames) {
  const roots = [...refNames].sort(compareUtf8);
  const closure = String(runIsolatedGit(auditRepository, ["rev-list", "--objects", "--missing=print", ...roots]));
  if (closure.split(/\r?\n/u).some((line) => line.startsWith("?"))) {
    throw new Error("public ref object closure is incomplete");
  }
  const fsck = runIsolatedGit(auditRepository, ["fsck", "--full", "--strict", "--no-reflogs"], { allowFailure: true });
  if (fsck.status !== 0) {
    throw new Error(`public ref object closure failed git fsck: ${String(fsck.stderr || fsck.stdout).trim()}`);
  }
}

function deterministicCollectionTime(auditRepository, refNames) {
  const commits = String(runIsolatedGit(auditRepository, ["rev-list", ...refNames]))
    .split(/\r?\n/u).filter(Boolean).sort();
  let maximum = 0;
  for (const commit of commits) {
    const epoch = Number(String(runIsolatedGit(auditRepository, ["show", "-s", "--format=%ct", commit])).trim());
    if (Number.isSafeInteger(epoch) && epoch > maximum) maximum = epoch;
  }
  return new Date(maximum * 1000).toISOString();
}

function validateScopeOptions(repositoryRoot, options) {
  if (!['public-remote', 'proposed-public-ref'].includes(options.scope)) {
    throw new Error("--scope must be public-remote or proposed-public-ref; implicit all-ref auditing is forbidden");
  }
  if (options.scope === "public-remote") {
    if (options.proposedRef || options.proposedCommit) throw new Error("public-remote scope does not accept a proposed ref or commit");
    return null;
  }
  if (!options.proposedRef || !options.proposedCommit) {
    throw new Error("proposed-public-ref scope requires --proposed-ref and --proposed-commit");
  }
  validateRefName(repositoryRoot, options.proposedRef);
  if (!OID_PATTERN.test(options.proposedCommit)) throw new Error("proposed commit must be an exact lowercase object ID");
  const resolved = String(runIsolatedGit(repositoryRoot, ["rev-parse", "--verify", `${options.proposedCommit}^{commit}`])).trim();
  if (resolved !== options.proposedCommit) throw new Error("proposed commit is not the exact local commit requested");
  return { name: options.proposedRef, oid: resolved };
}

export function withPublicRefScope(options, callback) {
  const repositoryRoot = realpathSync(path.resolve(options.root));
  const top = realpathSync(String(runIsolatedGit(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim());
  if (top !== repositoryRoot) throw new Error(`public-ref source root must be the Git top level: ${top}`);
  const proposed = validateScopeOptions(repositoryRoot, options);
  const remoteName = options.remote ?? "origin";
  const remoteUrl = String(runIsolatedGit(repositoryRoot, ["remote", "get-url", remoteName])).trim();
  const remote = normalizeRemoteUrl(repositoryRoot, remoteUrl);
  const advertisement = options.testOnlyAdvertisement ?? String(runIsolatedGit(
    repositoryRoot,
    ["ls-remote", "--heads", "--tags", remoteName],
  ));
  const publicRemoteRefs = parsePublicRefAdvertisement(repositoryRoot, advertisement);
  const objectFormat = String(runIsolatedGit(repositoryRoot, ["rev-parse", "--show-object-format"])).trim();
  if (!/^(?:sha1|sha256)$/u.test(objectFormat)) throw new Error(`unsupported Git object format: ${objectFormat}`);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-public-ref-audit-"));
  const auditRepository = path.join(temporaryRoot, "public.git");
  try {
    runIsolatedGit(temporaryRoot, ["init", "--bare", "-q", `--object-format=${objectFormat}`, auditRepository]);
    const refspecs = publicRemoteRefs.map((ref) => `+${ref.name}:${ref.name}`);
    runIsolatedGit(auditRepository, [
      "fetch", "--quiet", "--force", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
      remote.fetchUrl,
      ...refspecs,
    ]);
    verifyAdvertisedRefs(auditRepository, publicRemoteRefs);

    const effective = new Map(publicRemoteRefs.map((ref) => [ref.name, { ...ref }]));
    if (proposed) {
      const proposedImportRef = "refs/codex-public-audit/proposed";
      runIsolatedGit(auditRepository, [
        "fetch", "--quiet", "--force", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
        repositoryRoot,
        `+${proposed.oid}:${proposedImportRef}`,
      ]);
      const imported = String(runIsolatedGit(auditRepository, ["rev-parse", "--verify", `${proposedImportRef}^{commit}`])).trim();
      if (imported !== proposed.oid) throw new Error("proposed commit import did not preserve the exact object ID");
      runIsolatedGit(auditRepository, ["update-ref", proposed.name, proposed.oid]);
      runIsolatedGit(auditRepository, ["update-ref", "-d", proposedImportRef]);
      effective.set(proposed.name, { name: proposed.name, oid: proposed.oid });
    }

    const refs = [...effective.values()].sort((left, right) => compareUtf8(left.name, right.name));
    const refNames = refs.map((ref) => ref.name);
    verifyObjectClosure(auditRepository, refNames);
    const scope = {
      schemaVersion: 1,
      remoteIdentity: remote.remoteIdentity,
      repository: remote.repository,
      collectedAt: deterministicCollectionTime(auditRepository, refNames),
      refs,
      refSetSha256: "",
    };
    scope.refSetSha256 = computePublicRefSetSha256(scope);
    const sourceWasShallow = String(runIsolatedGit(repositoryRoot, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
    if (existsSync(path.join(auditRepository, "shallow"))) throw new Error("isolated public-ref audit repository unexpectedly remained shallow");
    return callback({
      auditRepository,
      scope,
      publicRemoteRefs,
      publicRemoteRefSetSha256: computePublicRefSetSha256({ ...scope, refs: publicRemoteRefs }),
      proposed,
      sourceWasShallow,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
