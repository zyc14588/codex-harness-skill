#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyPublicHistoryRiskAcceptance } from "./public-history-risk-acceptance.mjs";

const MAX_SCANNED_BLOB_BYTES = 10_000_000;
const LARGE_OBJECT_BYTES = 5_000_000;
const AUDIT_EVIDENCE_PATH = "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json";
const SAFE_EMAIL_DOMAINS = new Set(["example.invalid", "users.noreply.github.com", "localhost", "example.com", "example.org", "example.net"]);
const SECRET_RULES = [
  ["pem_private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu],
  ["github_pat", /\b(?:gh[opusr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{40,})\b/gu],
  ["openai_or_provider_key", /\b(?:sk|dsk)-[A-Za-z0-9_-]{24,}\b/gu],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu],
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|localhost)\b/giu;
const LOCAL_HOME_PATTERN = /(?:\/home\/|\/Users\/)([A-Za-z0-9._-]{1,64})(?=\/|\b)/gu;
const SAFE_LOCAL_ACCOUNTS = new Set(["codex", "codex-harness-tool", "root", "runner", "ubuntu", "user"]);
const PERSONAL_INFORMATION_CANDIDATE_RULES = [
  ["phone_number_candidate", /(?<![0-9A-Fa-f])1[3-9]\d{9}(?![0-9A-Fa-f])/gu],
  ["national_identifier_candidate", /(?<![0-9A-Fa-f])\d{17}[0-9Xx](?![0-9A-Fa-f])/gu],
  ["labelled_student_identifier_candidate", /(?:student[\s_-]*id|学号)\s*[:=：]\s*[A-Za-z0-9-]{4,32}/giu],
  ["labelled_postal_address_candidate", /(?:postal address|mailing address|住址|通信地址|家庭地址)\s*[:=：]\s*[^\r\n]{4,160}/giu],
];
const LFS_POINTER_PATTERN = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\s*$/mu;

function progress(message) {
  if (process.env.CODEX_PUBLIC_AUDIT_PROGRESS === "1") process.stderr.write(`[public-audit] ${message}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, args, options = {}) {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "core.fsmonitor=false",
    "-C", root,
    ...args,
  ], { encoding: options.encoding ?? "utf8", maxBuffer: options.maxBuffer ?? 64_000_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function gitStatus(root, args, options = {}) {
  return spawnSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "core.fsmonitor=false",
    "-C", root,
    ...args,
  ], { encoding: options.encoding ?? "utf8", maxBuffer: options.maxBuffer ?? 64_000_000 });
}

function regularJsonInput(target, label) {
  const resolved = path.resolve(target);
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${resolved}`);
  const bytes = readFileSync(resolved);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
}

function zeroSplit(value) {
  return String(value).split("\0").filter(Boolean);
}

function lines(value) {
  return String(value).split(/\r?\n/u).filter(Boolean);
}

function redactFinding(rule, locator, matched) {
  return {
    rule,
    locator,
    matchSha256: sha256(Buffer.from(matched, "utf8")),
    matchedUtf8Bytes: Buffer.byteLength(matched, "utf8"),
  };
}

function scanText(text, locator, findings) {
  for (const [rule, pattern] of SECRET_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.secrets.push(redactFinding(rule, locator, match[0]));
  }
  EMAIL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const domain = String(match[1]).toLowerCase();
    const local = match[0].slice(0, match[0].lastIndexOf("@")).toLowerCase();
    if (SAFE_EMAIL_DOMAINS.has(domain) || domain.endsWith(".invalid") || domain.endsWith(".test") || domain.endsWith(".service")) continue;
    if (domain === "github.com" && local === "git") continue;
    findings.personalInformation.push({
      ...redactFinding("personal_email", locator, match[0]),
      domain,
      identifierShape: /^[0-9]{9}@qq\.com$/u.test(match[0]) ? "9_DIGIT_ACCOUNT_IDENTIFIER_AT_QQ_COM" : "OTHER_EMAIL_IDENTIFIER",
    });
  }
  LOCAL_HOME_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(LOCAL_HOME_PATTERN)) {
    const account = String(match[1]).toLowerCase();
    if (SAFE_LOCAL_ACCOUNTS.has(account)) continue;
    findings.personalInformation.push({
      ...redactFinding("personal_local_home", locator, match[0]),
      identityClass: "local_home_account",
    });
  }
  for (const [rule, pattern] of PERSONAL_INFORMATION_CANDIDATE_RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.personalInformationCandidates.push({
        ...redactFinding(rule, locator, match[0]),
        reviewRequired: true,
      });
    }
  }
  const lfs = LFS_POINTER_PATTERN.exec(text);
  if (lfs) {
    findings.lfsPointers.push({ locator, oidSha256: lfs[1], declaredBytes: Number(lfs[2]) });
  }
}

function safeArchiveEntry(entry) {
  if (!entry || entry.includes("\0") || entry.includes("\\")) return false;
  if (entry.startsWith("/") || /^[A-Za-z]:\//u.test(entry)) return false;
  const normalized = path.posix.normalize(entry);
  return normalized !== ".." && !normalized.startsWith("../");
}

function inspectZip(data, locator, findings, coverage, inventory) {
  progress(`zip start ${locator}`);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-history-zip-"));
  const zipPath = path.join(temporary, "archive.zip");
  try {
    writeFileSync(zipPath, data, { mode: 0o600 });
    const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 16_000_000 });
    if (listing.status !== 0) {
      findings.archiveIntegrity.push({ rule: "invalid_zip", locator, stderrSha256: sha256(String(listing.stderr ?? "")) });
      return;
    }
    const entries = lines(listing.stdout);
    coverage.zipFileInspectionsOverlapInclusive += 1;
    coverage.zipMemberOccurrencesOverlapInclusive += entries.length;
    const archiveSha256 = sha256(data);
    const firstUniqueInspection = !inventory.archiveSha256.has(archiveSha256);
    if (firstUniqueInspection) {
      inventory.archiveSha256.add(archiveSha256);
      coverage.uniqueZipFiles += 1;
      coverage.zipMembersAfterZipBlobDeduplication += entries.length;
      for (const entry of entries) inventory.uniqueArchiveEntries.push(entry);
    }
    const regularEntries = [];
    for (const entry of entries) {
      if (!safeArchiveEntry(entry)) {
        findings.archiveIntegrity.push({ rule: "unsafe_zip_entry", locator, entrySha256: sha256(entry) });
        continue;
      }
      if (!entry.endsWith("/")) regularEntries.push(entry);
    }
    if (regularEntries.length) {
      const extracted = spawnSync("unzip", ["-p", zipPath, ...regularEntries], { encoding: null, maxBuffer: 100_000_000 });
      if (Buffer.isBuffer(extracted.stdout) && extracted.stdout.length) {
        scanText(extracted.stdout.toString("utf8"), `${locator}![aggregate-members]`, findings);
      }
      if (extracted.error?.code === "ENOBUFS") {
        findings.largeObjects.push({ locator: `${locator}![aggregate-members]`, bytes: 100_000_000, source: "zip_members_at_least" });
      } else if (extracted.status !== 0) {
        findings.archiveIntegrity.push({ rule: "zip_member_read_failed", locator, stderrSha256: sha256(String(extracted.stderr ?? "")) });
      }
    }
    progress(`zip complete ${locator}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {
    root: process.cwd(), output: undefined, failOnBlockers: false,
    ownerAcceptance: undefined, baselineAudit: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") result.root = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--owner-acceptance") result.ownerAcceptance = argv[++index];
    else if (arg === "--baseline-audit") result.baselineAudit = argv[++index];
    else if (arg === "--fail-on-blockers") result.failOnBlockers = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.root) throw new Error("--root requires a path");
  return result;
}

function currentDependencyLicenseReview(root) {
  const packagePath = path.join(root, "current/bridge/package.json");
  const lockPath = path.join(root, "current/bridge/package-lock.json");
  try {
    const packageInfo = lstatSync(packagePath);
    const lockInfo = lstatSync(lockPath);
    if (!packageInfo.isFile() || packageInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.isSymbolicLink()) {
      throw new Error("unsafe package metadata input");
    }
  } catch {
    return { status: "NOT_APPLICABLE_NO_CURRENT_BRIDGE_PACKAGE", runtimeDependencyCount: 0, entries: [], unresolved: [] };
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const lockJson = JSON.parse(readFileSync(lockPath, "utf8"));
  const runtimeDependencies = packageJson.dependencies ?? {};
  const direct = { ...runtimeDependencies, ...(packageJson.devDependencies ?? {}) };
  const lockedPackageNames = Object.keys(lockJson.packages ?? {})
    .filter((entry) => entry.startsWith("node_modules/"))
    .map((entry) => entry.slice("node_modules/".length));
  const packageNames = [...new Set([...Object.keys(direct), ...lockedPackageNames])].sort();
  const entries = [];
  const unresolved = [];
  for (const name of packageNames) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) {
      unresolved.push({ packageNameSha256: sha256(name), reason: "UNSAFE_PACKAGE_NAME" });
      continue;
    }
    const installedRoot = path.join(root, "current/bridge/node_modules", ...name.split("/"));
    try {
      const installedInfo = lstatSync(installedRoot);
      if (!installedInfo.isDirectory() || installedInfo.isSymbolicLink()) throw new Error("unsafe installed package path");
      const metadataPath = path.join(installedRoot, "package.json");
      const metadataInfo = lstatSync(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new Error("unsafe installed package metadata");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      const licenseFiles = readdirSync(installedRoot)
        .filter((entry) => /^(?:license|copying)(?:\.[A-Za-z0-9._-]+)?$/iu.test(entry))
        .sort();
      let licenseFileSha256 = null;
      if (licenseFiles.length) {
        const licenseTarget = path.join(installedRoot, licenseFiles[0]);
        const licenseInfo = lstatSync(licenseTarget);
        if (!licenseInfo.isFile() || licenseInfo.isSymbolicLink()) throw new Error("unsafe installed license file");
        licenseFileSha256 = sha256(readFileSync(licenseTarget));
      }
      const locked = lockJson.packages?.[`node_modules/${name}`];
      const entry = {
        name,
        declaredRange: direct[name] === undefined ? null : String(direct[name]),
        installedVersion: String(metadata.version ?? ""),
        lockedVersion: String(locked?.version ?? ""),
        license: String(metadata.license ?? ""),
        licenseFileSha256,
        runtime: locked?.dev !== true,
      };
      entries.push(entry);
      if (!entry.installedVersion || entry.installedVersion !== entry.lockedVersion || !entry.license || !licenseFileSha256) {
        unresolved.push({ packageNameSha256: sha256(name), reason: "VERSION_OR_LICENSE_PROVENANCE_INCOMPLETE" });
      }
    } catch {
      unresolved.push({ packageNameSha256: sha256(name), reason: "INSTALLED_LICENSE_METADATA_UNAVAILABLE" });
    }
  }
  return {
    status: unresolved.length ? "BLOCKED_THIRD_PARTY_LICENSE_REVIEW_INCOMPLETE" : "PASS_CURRENT_DECLARED_DEPENDENCY_LICENSE_REVIEW",
    runtimeDependencyCount: Object.keys(runtimeDependencies).length,
    entries,
    unresolved,
  };
}

function readBlobBatch(root, objectIds) {
  if (!objectIds.length) return new Map();
  const output = new Map();
  const requested = new Set(objectIds);
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch-all-objects", "--batch"], {
    encoding: null, maxBuffer: 256_000_000,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`git cat-file --batch-all-objects failed: ${String(result.stderr ?? "").trim()}`);
  }
  let offset = 0;
  while (offset < result.stdout.length) {
    const newline = result.stdout.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("malformed git cat-file batch header");
    const header = result.stdout.subarray(offset, newline).toString("utf8");
    const [oid, type, sizeText] = header.split(" ");
    if (!/^(?:blob|commit|tag|tree)$/u.test(type ?? "") || !/^\d+$/u.test(sizeText ?? "")) {
      throw new Error(`unexpected git cat-file batch header: ${header}`);
    }
    const size = Number(sizeText);
    const start = newline + 1;
    const end = start + size;
    if (end >= result.stdout.length || result.stdout[end] !== 0x0a) throw new Error(`truncated git object batch response for ${oid}`);
    if (type === "blob" && requested.has(oid)) output.set(oid, result.stdout.subarray(start, end));
    offset = end + 1;
  }
  return output;
}

export function auditPublicRepository(options) {
  const root = path.resolve(options.root);
  const top = path.resolve(String(git(root, ["rev-parse", "--show-toplevel"])).trim());
  if (top !== root) throw new Error(`audit root must be the Git top level: ${top}`);
  const findings = {
    secrets: [], personalInformation: [], personalInformationCandidates: [], lfsPointers: [],
    unsafeGitObjects: [], archiveIntegrity: [], largeObjects: [],
  };
  const coverage = {
    refs: 0, commits: 0, objects: 0, blobs: 0, scannedTextBlobs: 0, skippedBinaryBlobs: 0,
    oversizedBlobs: 0, trackedWorktreePaths: 0, scannedTrackedWorktreeFiles: 0, untrackedPaths: 0, ignoredPaths: 0,
    archivePaths: 0, evidencePaths: 0, logPaths: 0, promptPaths: 0, zipBlobs: 0,
    uniqueZipFiles: 0, zipFileInspectionsOverlapInclusive: 0,
    zipMemberOccurrencesOverlapInclusive: 0, zipMembersAfterZipBlobDeduplication: 0,
    selfEvidenceContentExclusions: 0,
  };
  const zipInventory = { archiveSha256: new Set(), uniqueArchiveEntries: [] };

  const refs = lines(git(root, ["for-each-ref", "--format=%(refname)%09%(objectname)"]));
  coverage.refs = refs.length;
  const commits = lines(git(root, ["rev-list", "--all"]));
  coverage.commits = commits.length;
  const objectPathLines = lines(git(root, ["rev-list", "--objects", "--all"]));
  progress(`object inventory ${objectPathLines.length}`);
  const objectPaths = new Map();
  for (const line of objectPathLines) {
    const split = line.indexOf(" ");
    const oid = split < 0 ? line : line.slice(0, split);
    const objectPath = split < 0 ? "" : line.slice(split + 1);
    if (!objectPaths.has(oid)) objectPaths.set(oid, objectPath);
  }
  coverage.objects = objectPaths.size;
  const batch = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    encoding: "utf8", maxBuffer: 64_000_000,
  });
  if (batch.status !== 0) throw new Error(`git cat-file --batch-check failed: ${String(batch.stderr).trim()}`);
  const blobMetadata = [];
  for (const line of lines(batch.stdout)) {
    const [oid, type, sizeText] = line.split(" ");
    if (!objectPaths.has(oid)) continue;
    if (type !== "blob") continue;
    coverage.blobs += 1;
    const size = Number(sizeText);
    const objectPath = objectPaths.get(oid) || "[path-not-recorded]";
    const locator = `git-blob:${oid}:${objectPath}`;
    if (/^(?:archive\/|.*\/archive\/)/u.test(objectPath)) coverage.archivePaths += 1;
    if (/^(?:evidence\/|.*\/evidence\/)/u.test(objectPath)) coverage.evidencePaths += 1;
    if (/(?:^|\/)(?:logs?|.*\.log)(?:\/|$)/iu.test(objectPath)) coverage.logPaths += 1;
    if (/(?:^|\/).*prompt.*$/iu.test(objectPath)) coverage.promptPaths += 1;
    if (size >= LARGE_OBJECT_BYTES) findings.largeObjects.push({ locator, bytes: size, source: "git_blob" });
    if (size > MAX_SCANNED_BLOB_BYTES) { coverage.oversizedBlobs += 1; continue; }
    blobMetadata.push({ oid, objectPath, locator });
  }
  const blobData = readBlobBatch(root, blobMetadata.map((item) => item.oid));
  progress(`blob batch loaded ${blobMetadata.length}`);
  for (const { oid, objectPath, locator } of blobMetadata) {
    const buffer = blobData.get(oid);
    if (!buffer) throw new Error(`missing blob data for ${oid}`);
    if (/\.zip$/iu.test(objectPath) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      coverage.zipBlobs += 1;
      inspectZip(buffer, locator, findings, coverage, zipInventory);
    }
    if (buffer.includes(0)) { coverage.skippedBinaryBlobs += 1; continue; }
    coverage.scannedTextBlobs += 1;
    scanText(buffer.toString("utf8"), locator, findings);
  }

  const metadataFormat = "%H%x00%ae%x00%ce%x00";
  progress("blob scans complete");
  const metadata = zeroSplit(git(root, ["log", "--all", `--format=${metadataFormat}`]));
  for (let index = 0; index + 2 < metadata.length; index += 3) {
    const [rawCommit, authorEmail, committerEmail] = metadata.slice(index, index + 3);
    const commit = rawCommit.trim();
    scanText(authorEmail, `commit:${commit}:authorEmail`, findings);
    scanText(committerEmail, `commit:${commit}:committerEmail`, findings);
  }

  const trees = [...new Set(lines(git(root, ["log", "--all", "--format=%T"])))];
  progress(`tree scans start ${trees.length}`);
  for (const tree of trees) {
    for (const entry of zeroSplit(git(root, ["ls-tree", "-r", "-z", tree]))) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, oid] = entry.slice(0, tab).split(/\s+/u);
      if (mode === "120000" || mode === "160000" || type === "commit") {
        findings.unsafeGitObjects.push({ tree, mode, type, oid, pathSha256: sha256(entry.slice(tab + 1)) });
      }
    }
  }

  const refRecords = refs.map((item) => { const [name, oid] = item.split("\t"); return { name, oid }; });
  const gitmodulesInHistory = [...objectPaths.values()].filter((value) => /(^|\/)\.gitmodules$/iu.test(value));
  const historicalGitlinkMap = new Map();
  for (const commit of [...commits].reverse()) {
    for (const entry of zeroSplit(git(root, ["ls-tree", "-r", "-z", commit]))) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, oid] = entry.slice(0, tab).split(/\s+/u);
      if (mode !== "160000" && type !== "commit") continue;
      const gitlinkPath = entry.slice(tab + 1);
      const key = `${oid}:${gitlinkPath}`;
      if (!historicalGitlinkMap.has(key)) {
        historicalGitlinkMap.set(key, { commit, path: gitlinkPath, mode, type, oid });
      }
    }
  }
  const historicalGitlinks = [...historicalGitlinkMap.values()].map((item) => {
    const containing = lines(git(root, ["for-each-ref", "--contains", item.commit, "--format=%(refname)"])).sort();
    const exactRef = refRecords.find((entry) => entry.oid === item.commit)?.name;
    const targetProbe = gitStatus(root, ["cat-file", "-e", `${item.oid}^{commit}`]);
    const targetPathPresentInZip = zipInventory.uniqueArchiveEntries.some((entry) => (
      entry === item.path || entry.startsWith(`${item.path}/`) || entry.includes(`/${item.path}/`)
    ));
    const nestedGitMetadataInZip = zipInventory.uniqueArchiveEntries.some((entry) => /(^|\/)\.git(?:modules|\/|$)/iu.test(entry));
    return {
      ref: exactRef ?? containing[0] ?? null,
      reachableFromRefs: containing,
      commit: item.commit,
      path: item.path,
      mode: item.mode,
      type: item.type,
      objectId: item.oid,
      gitmodulesPresent: gitmodulesInHistory.length > 0,
      externalUrl: null,
      targetAccessible: targetProbe.status === 0,
      externalContentPresentInRepository: targetProbe.status === 0,
      externalContentPresentInHistoricalZips: targetPathPresentInZip || nestedGitMetadataInZip,
      classifications: [
        "ACCEPTED_OPAQUE_HISTORICAL_REFERENCE",
        "EXTERNAL_CONTENT_NOT_DISTRIBUTED",
        "EXCLUDED_FROM_RELEASE_PROVENANCE",
      ],
      licenseStatement: "INACCESSIBLE_EXTERNAL_TARGET_LICENSE_COMPLIANCE_NOT_VERIFIED",
    };
  });

  const tracked = zeroSplit(git(root, ["ls-files", "-z"]));
  progress("tree scans complete");
  const untracked = zeroSplit(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const ignored = zeroSplit(git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
  coverage.trackedWorktreePaths = tracked.length;
  coverage.untrackedPaths = untracked.length;
  coverage.ignoredPaths = ignored.length;
  const activeIndex = zeroSplit(git(root, ["ls-files", "-s", "-z", "--", "current"]));
  const activeGitlinks = [];
  const activeGitmodules = [];
  for (const entry of activeIndex) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode] = entry.slice(0, tab).split(/\s+/u);
    const relative = entry.slice(tab + 1);
    if (mode === "160000") activeGitlinks.push(relative);
    if (/(^|\/)\.gitmodules$/iu.test(relative)) activeGitmodules.push(relative);
  }
  for (const relative of untracked) {
    if (relative === "current/.gitmodules" || (relative.startsWith("current/") && /(^|\/)\.gitmodules$/iu.test(relative))) {
      activeGitmodules.push(relative);
    }
  }
  for (const relative of tracked) {
    if (relative === AUDIT_EVIDENCE_PATH) {
      coverage.selfEvidenceContentExclusions += 1;
      continue;
    }
    const absolute = path.join(root, relative);
    let info;
    try { info = lstatSync(absolute); } catch { continue; }
    if (info.isSymbolicLink()) {
      findings.unsafeGitObjects.push({ tree: "WORKTREE", mode: "120000", type: "symlink", oid: "WORKTREE", pathSha256: sha256(relative) });
      continue;
    }
    if (!info.isFile()) continue;
    coverage.scannedTrackedWorktreeFiles += 1;
    if (info.size >= LARGE_OBJECT_BYTES) findings.largeObjects.push({ locator: `worktree-tracked:${relative}`, bytes: info.size, source: "worktree_tracked" });
    if (info.size > MAX_SCANNED_BLOB_BYTES) continue;
    const data = readFileSync(absolute);
    if (/\.zip$/iu.test(relative) || (data[0] === 0x50 && data[1] === 0x4b)) {
      inspectZip(data, `worktree-tracked:${relative}`, findings, coverage, zipInventory);
    }
    if (!data.includes(0)) scanText(data.toString("utf8"), `worktree-tracked:${relative}`, findings);
  }
  for (const relative of untracked) {
    if (relative === AUDIT_EVIDENCE_PATH) {
      coverage.selfEvidenceContentExclusions += 1;
      continue;
    }
    const absolute = path.join(root, relative);
    let info;
    try { info = lstatSync(absolute); } catch { continue; }
    if (info.isSymbolicLink()) {
      findings.unsafeGitObjects.push({ tree: "WORKTREE_UNTRACKED", mode: "120000", type: "symlink", oid: "WORKTREE", pathSha256: sha256(relative) });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size >= LARGE_OBJECT_BYTES) findings.largeObjects.push({ locator: `untracked:${sha256(relative)}`, bytes: info.size, source: "worktree_untracked" });
    if (info.size > MAX_SCANNED_BLOB_BYTES) continue;
    const data = readFileSync(absolute);
    if (!data.includes(0)) scanText(data.toString("utf8"), `untracked:${sha256(relative)}`, findings);
  }

  const trackedLower = tracked.map((item) => item.toLowerCase());
  const licensePaths = tracked.filter((item) => /(^|\/)(license|copying)(\.[a-z0-9_-]+)?$/iu.test(item));
  const thirdPartyDependencyReview = currentDependencyLicenseReview(root);
  const duplicates = (items) => {
    const seen = new Set();
    return items.filter((item) => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  for (const key of Object.keys(findings)) findings[key] = duplicates(findings[key]);
  const groupPrivacyFindings = (items) => {
    const groups = new Map();
    for (const item of items) {
    const key = `${item.rule}:${item.matchSha256}:${item.domain ?? ""}:${item.identityClass ?? ""}`;
      const existing = groups.get(key) ?? {
      rule: item.rule,
      matchSha256: item.matchSha256,
      matchedUtf8Bytes: item.matchedUtf8Bytes,
      ...(item.domain ? { domain: item.domain } : {}),
      ...(item.identityClass ? { identityClass: item.identityClass } : {}),
      ...(item.identifierShape ? { identifierShape: item.identifierShape } : {}),
      ...(item.reviewRequired ? { reviewRequired: true } : {}),
      occurrenceCount: 0,
      representativeLocators: [],
      _commitLocators: new Set(),
      _historicalZipLocators: new Set(),
    };
    existing.occurrenceCount += 1;
    if (existing.representativeLocators.length < 5) existing.representativeLocators.push(item.locator);
    const commitMatch = /^commit:([0-9a-f]{40,64}):/u.exec(item.locator);
    if (commitMatch) existing._commitLocators.add(commitMatch[1]);
    const zipMatch = /^git-blob:([0-9a-f]{40,64}):.*\.zip!\[aggregate-members\]$/iu.exec(item.locator);
    if (zipMatch) existing._historicalZipLocators.add(zipMatch[1]);
      groups.set(key, existing);
    }
    return [...groups.values()].map((item) => {
      const value = { ...item };
      if (item._commitLocators.size > 0) value.uniqueCommitCount = item._commitLocators.size;
      if (item._historicalZipLocators.size > 0) value.uniqueHistoricalZipCount = item._historicalZipLocators.size;
      delete value._commitLocators;
      delete value._historicalZipLocators;
      return value;
    });
  };
  findings.personalInformation = groupPrivacyFindings(findings.personalInformation);
  findings.personalInformationCandidates = groupPrivacyFindings(findings.personalInformationCandidates);
  const gitObjectGroups = new Map();
  for (const item of findings.unsafeGitObjects) {
    const key = `${item.mode}:${item.type}:${item.oid}:${item.pathSha256}`;
    const existing = gitObjectGroups.get(key) ?? { mode: item.mode, type: item.type, oid: item.oid, pathSha256: item.pathSha256, treeCount: 0, representativeTrees: [] };
    existing.treeCount += 1;
    if (existing.representativeTrees.length < 5) existing.representativeTrees.push(item.tree);
    gitObjectGroups.set(key, existing);
  }
  findings.unsafeGitObjects = [...gitObjectGroups.values()];
  const blockers = [];
  if (findings.secrets.length) blockers.push("HISTORICAL_OR_CURRENT_SECRET_MATERIAL");
  if (findings.personalInformation.length) blockers.push("PUBLIC_HISTORY_PERSONAL_INFORMATION");
  if (findings.personalInformationCandidates.length) blockers.push("POTENTIAL_PERSONAL_INFORMATION_REVIEW_REQUIRED");
  if (findings.lfsPointers.length) blockers.push("GIT_LFS_CONTENT_NOT_AUDITED");
  if (findings.unsafeGitObjects.length) blockers.push("UNSAFE_SYMLINK_OR_GITLINK_IN_HISTORY");
  if (findings.archiveIntegrity.length) blockers.push("ARCHIVE_INTEGRITY_OR_PATH_TRAVERSAL");
  if (!licensePaths.length) blockers.push("LICENSE_FILE_MISSING");
  if (thirdPartyDependencyReview.status === "BLOCKED_THIRD_PARTY_LICENSE_REVIEW_INCOMPLETE") {
    blockers.push("THIRD_PARTY_LICENSE_REVIEW_INCOMPLETE");
  }
  const result = {
    schemaVersion: 2,
    auditPolicy: "DEC-001-full-repository-and-history-audit-v1",
    observedAt: new Date().toISOString(),
    repositoryRootSha256: sha256(root),
    head: String(git(root, ["rev-parse", "HEAD"])).trim(),
    result: blockers.length ? "BLOCKED_PUBLIC_HISTORY_REMEDIATION" : "PASS_PUBLICATION_ELIGIBILITY_AUDIT",
    blockers,
    coverage,
    refs: refRecords,
    activeSource: {
      scope: "current/",
      trackedEntryCount: activeIndex.length,
      gitlinkCount: activeGitlinks.length,
      gitmodulePaths: [...new Set(activeGitmodules)].sort(),
      gitmodulesCount: new Set(activeGitmodules).size,
    },
    historicalGitlinks,
    worktree: {
      trackedPathSetSha256: sha256(trackedLower.sort().join("\0")),
      untrackedPathSetSha256: sha256(untracked.sort().join("\0")),
      ignoredPathSetSha256: sha256(ignored.sort().join("\0")),
    },
    licensing: { licensePaths, present: licensePaths.length > 0, thirdPartyDependencyReview },
    publicationClassification: {
      secretsAndCredentials: findings.secrets.length === 0
        ? "NO_CONFIRMED_SECRET_OR_CREDENTIAL_MATERIAL"
        : "BLOCKED_CONFIRMED_SECRET_OR_CREDENTIAL_MATERIAL",
      credentialShapedFalsePositives: [
        { rule: "ssh_remote_user_at_host", disposition: "EXCLUDED_NOT_AN_EMAIL_OR_CREDENTIAL" },
        { rule: "systemd_user_unit_domain_like_suffix", disposition: "EXCLUDED_NOT_AN_EMAIL_OR_CREDENTIAL" },
      ],
      personalInformation: findings.personalInformation.length === 0
        ? "NO_PERSONAL_INFORMATION_DETECTED"
        : "BLOCKED_HASH_REDACTED_PERSONAL_INFORMATION_DETECTED",
      confidentialOrUnreleasedMaterial: coverage.archivePaths + coverage.evidencePaths + coverage.logPaths + coverage.promptPaths > 0
        ? "PROJECT_INTERNAL_PROVENANCE_PRESENT_NO_CONFIDENTIALITY_MARKER_CONFIRMED"
        : "NO_PROJECT_INTERNAL_PROVENANCE_PATHS_DETECTED",
      copyrightAndLicensing: findings.unsafeGitObjects.length > 0
        ? "BLOCKED_LICENSE_PRESENT_BUT_HISTORICAL_GITLINK_PROVENANCE_UNRESOLVED"
        : licensePaths.length > 0 ? "LICENSE_PRESENT_NO_UNRESOLVED_GIT_OBJECT_PROVENANCE" : "BLOCKED_LICENSE_MISSING",
      conditionallyAcceptableMaterial: [
        "source_code",
        "documentation_and_prompts",
        "hash_redacted_evidence_and_logs",
        "integrity_validated_archives",
      ],
      publicationEligibility: blockers.length === 0 ? "ELIGIBLE" : "NOT_ELIGIBLE_UNTIL_BLOCKERS_REMEDIATED_AND_REAUDITED",
    },
    findings,
    remediationRequired: blockers.length > 0,
    remediationAuthorityRequired: blockers.length > 0,
    notes: [
      "Findings contain hashes and structural locators only; matching secret or personal values are never emitted.",
      `${AUDIT_EVIDENCE_PATH} remains in the exact worktree path-set commitment but its current content is excluded to prevent self-referential audit evidence; prior committed versions remain covered by the all-history blob scan.`,
      "Ignored paths are inventoried but not content-scanned because they are outside the Git-published repository; tracked, untracked, all refs, and all reachable historical blobs are covered.",
      "No history rewrite, remote deletion, visibility change, branch protection mutation, push, or release action is performed by this audit.",
    ],
  };
  if (options.ownerAcceptance || options.baselineAudit) {
    if (!options.ownerAcceptance || !options.baselineAudit) {
      throw new Error("--owner-acceptance and --baseline-audit must be supplied together");
    }
    const owner = regularJsonInput(options.ownerAcceptance, "Owner acceptance");
    const baseline = regularJsonInput(options.baselineAudit, "baseline public-history audit");
    result.auditPolicy = "DEC-001-full-repository-and-history-audit-v2-owner-acceptance";
    applyPublicHistoryRiskAcceptance(result, {
      ownerAcceptance: owner.value,
      baselineAudit: baseline.value,
      baselineAuditSha256: baseline.sha256,
    });
    result.ownerAcceptance = {
      path: path.relative(root, path.resolve(options.ownerAcceptance)).split(path.sep).join("/"),
      sha256: owner.sha256,
      baselineAuditPath: path.relative(root, path.resolve(options.baselineAudit)).split(path.sep).join("/"),
      baselineAuditSha256: baseline.sha256,
    };
  }
  return result;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = auditPublicRepository(options);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) writeFileSync(path.resolve(options.output), output, { mode: 0o600 });
    process.stdout.write(output);
    if (options.failOnBlockers && result.blockers.length) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
