#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedGit } from "./public-ref-scope.mjs";

const LEGACY_BASELINE_SHA256 = "3af7e6be9ad2498bca234e469529098f871d795df9da972c2434ca5e308a3afb";
const EMAIL_MAXIMUM = 64;
const PATH_MAXIMUM = 136;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function regularJson(target, label) {
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${target}`);
  const bytes = readFileSync(target);
  return { bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString("utf8")) };
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function privacySignature(item, legacy = false) {
  if (item.rule === "personal_email") {
    return JSON.stringify({
      rule: item.rule,
      matchSha256: item.matchSha256,
      matchedUtf8Bytes: item.matchedUtf8Bytes,
      domain: item.domain,
      identifierShape: item.identifierShape ?? (legacy ? "9_DIGIT_ACCOUNT_IDENTIFIER_AT_QQ_COM" : undefined),
    });
  }
  if (item.rule === "personal_local_home") {
    return JSON.stringify({
      rule: item.rule,
      matchSha256: item.matchSha256,
      matchedUtf8Bytes: item.matchedUtf8Bytes,
      identityClass: item.identityClass,
    });
  }
  return JSON.stringify({ rule: item.rule, matchSha256: item.matchSha256 });
}

function gitlinkSignature(item) {
  return JSON.stringify({ mode: item.mode, type: item.type, oid: item.oid, pathSha256: item.pathSha256 });
}

function setDelta(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function finding(audit, rule) {
  const matches = (audit.findings?.personalInformation ?? []).filter((item) => item.rule === rule);
  if (matches.length !== 1) throw new Error(`audit must contain exactly one ${rule} finding`);
  return matches[0];
}

export function buildBaselineSupersession({ root, legacy, legacySha256, publicBaseline, publicBaselineSha256, legacyPath, publicPath }) {
  if (legacySha256 !== LEGACY_BASELINE_SHA256) throw new Error("legacy local-scope baseline bytes changed");
  if (publicBaseline.auditScope?.mode !== "public-remote") throw new Error("new baseline is not a public-remote audit");
  const legacyRefs = legacy.refs.map((ref) => JSON.stringify({ name: ref.name, oid: ref.oid })).sort();
  const publicRefs = publicBaseline.publicRefScope.refs.map((ref) => JSON.stringify(ref)).sort();
  const legacyRoots = [...new Set(legacy.refs.map((ref) => ref.oid))].sort();
  const legacyCommits = String(runIsolatedGit(root, ["rev-list", ...legacyRoots])).split(/\r?\n/u).filter(Boolean).sort();
  const publicCommits = [...publicBaseline.inventory.reachableCommits].sort();
  const legacyPrivacy = legacy.findings.personalInformation.map((item) => privacySignature(item, true)).sort();
  const publicPrivacy = publicBaseline.findings.personalInformation.map((item) => privacySignature(item)).sort();
  const legacyGitlinks = legacy.findings.unsafeGitObjects.map(gitlinkSignature).sort();
  const publicGitlinks = publicBaseline.findings.unsafeGitObjects.map(gitlinkSignature).sort();
  const legacyEmail = finding(legacy, "personal_email");
  const legacyPathFinding = finding(legacy, "personal_local_home");
  const publicEmail = finding(publicBaseline, "personal_email");
  const publicPathFinding = finding(publicBaseline, "personal_local_home");
  const newPrivacy = setDelta(publicPrivacy, legacyPrivacy);
  const removedPrivacy = setDelta(legacyPrivacy, publicPrivacy);
  const newGitlinks = setDelta(publicGitlinks, legacyGitlinks);
  const removedGitlinks = setDelta(legacyGitlinks, publicGitlinks);
  const newSecrets = publicBaseline.findings.secrets?.length ?? 0;
  const newArchiveFindings = publicBaseline.findings.archiveIntegrity?.length ?? 0;
  const newLicenseBlockers = publicBaseline.licensing?.thirdPartyDependencyReview?.unresolved?.length ?? 0;
  const countsWithinApproval = publicEmail.occurrenceCount <= EMAIL_MAXIMUM && publicPathFinding.occurrenceCount <= PATH_MAXIMUM;
  const noNewDistinctPersonalIdentifier = newPrivacy.length === 0;
  const exactApprovedGitlinks = newGitlinks.length === 0 && removedGitlinks.length === 0;
  const pass = noNewDistinctPersonalIdentifier && newSecrets === 0 && newArchiveFindings === 0
    && newLicenseBlockers === 0 && exactApprovedGitlinks && countsWithinApproval;
  return {
    schemaVersion: 1,
    generatedAt: publicBaseline.publicRefScope.collectedAt,
    status: pass ? "PUBLIC_REF_BASELINE_SUPERSEDES_LEGACY_LOCAL_SCOPE" : "BLOCKED_NEW_PUBLIC_HISTORY_FINDING",
    legacyBaseline: {
      path: legacyPath,
      sha256: legacySha256,
      scope: "LEGACY_LOCAL_FOR_EACH_REF_AND_REV_LIST_ALL",
      refCount: legacy.refs.length,
      refs: legacy.refs,
    },
    publicBaseline: {
      path: publicPath,
      sha256: publicBaselineSha256,
      scope: "PUBLIC_REMOTE_HEADS_AND_TAGS",
      refCount: publicBaseline.publicRefScope.refs.length,
      refSetSha256: publicBaseline.publicRefScope.refSetSha256,
      refs: publicBaseline.publicRefScope.refs,
    },
    refDelta: {
      added: setDelta(publicRefs, legacyRefs).map((item) => JSON.parse(item)),
      removed: setDelta(legacyRefs, publicRefs).map((item) => JSON.parse(item)),
    },
    reachableCommitDelta: {
      legacyCount: legacyCommits.length,
      publicCount: publicCommits.length,
      added: setDelta(publicCommits, legacyCommits),
      removed: setDelta(legacyCommits, publicCommits),
    },
    privacySignatureDelta: {
      legacySetSha256: sha256(legacyPrivacy.join("\n")),
      publicSetSha256: sha256(publicPrivacy.join("\n")),
      added: newPrivacy.map((item) => JSON.parse(item)),
      removed: removedPrivacy.map((item) => JSON.parse(item)),
    },
    occurrenceCountDelta: {
      personalEmail: {
        legacy: legacyEmail.occurrenceCount,
        public: publicEmail.occurrenceCount,
        delta: publicEmail.occurrenceCount - legacyEmail.occurrenceCount,
        ownerApprovedMaximum: EMAIL_MAXIMUM,
      },
      personalLocalHome: {
        legacy: legacyPathFinding.occurrenceCount,
        public: publicPathFinding.occurrenceCount,
        delta: publicPathFinding.occurrenceCount - legacyPathFinding.occurrenceCount,
        ownerApprovedMaximum: PATH_MAXIMUM,
      },
      interpretation: "COUNT_REDUCTION_REFLECTS_SCOPE_DEDUPLICATION_NOT_HISTORY_REWRITE",
    },
    historicalGitlinkDelta: {
      legacySetSha256: sha256(legacyGitlinks.join("\n")),
      publicSetSha256: sha256(publicGitlinks.join("\n")),
      added: newGitlinks.map((item) => JSON.parse(item)),
      removed: removedGitlinks.map((item) => JSON.parse(item)),
    },
    secretLicenseArchiveDelta: {
      legacySecrets: legacy.findings.secrets?.length ?? 0,
      publicSecrets: newSecrets,
      legacyArchiveIntegrityFindings: legacy.findings.archiveIntegrity?.length ?? 0,
      publicArchiveIntegrityFindings: newArchiveFindings,
      legacyLicenseReviewStatus: legacy.licensing?.thirdPartyDependencyReview?.status ?? null,
      publicLicenseReviewStatus: publicBaseline.licensing?.thirdPartyDependencyReview?.status ?? null,
      publicDistributedLicenseBlockers: newLicenseBlockers,
      legacyUniqueZipFiles: legacy.coverage.zipBlobs,
      publicUniqueZipFiles: publicBaseline.coverage.uniqueZipFiles,
      legacyZipMemberOccurrencesOverlapInclusive: legacy.coverage.zipEntries,
      publicZipMemberOccurrencesOverlapInclusive: publicBaseline.coverage.zipMemberOccurrencesOverlapInclusive,
      publicZipMembersAfterBlobDeduplication: publicBaseline.coverage.zipMembersAfterZipBlobDeduplication,
    },
    assurances: {
      noNewDistinctPersonalIdentifier,
      noNewSecret: newSecrets === 0,
      noNewGitlink: newGitlinks.length === 0,
      noNewDistributedLicenseBlocker: newLicenseBlockers === 0,
      ownerApprovedOccurrenceMaximumsRespected: countsWithinApproval,
      ownerDecisionContinuesToApply: pass,
    },
    ownerDecisionContinuationReason: "The accepted identifier and historical gitlink signatures are unchanged; only local-only, remote-tracking, and stash views were removed, and reduced counts remain below the Owner-approved maxima.",
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--root", "--legacy-baseline", "--legacy-copy", "--public-baseline", "--supersession"].includes(name)) {
      throw new Error(`unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    options[name.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  options.root = path.resolve(options.root ?? fileURLToPath(new URL("..", import.meta.url)));
  options.legacyBaseline = path.resolve(options.legacyBaseline ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json"));
  options.legacyCopy = path.resolve(options.legacyCopy ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_LOCAL_SCOPE_LEGACY.json"));
  options.publicBaseline = path.resolve(options.publicBaseline ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_PUBLIC_REF_BASELINE.json"));
  options.supersession = path.resolve(options.supersession ?? path.join(options.root, "current/evidence/PUBLIC_HISTORY_BASELINE_SUPERSESSION.json"));
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const legacy = regularJson(options.legacyBaseline, "legacy local-scope baseline");
    const publicBaseline = regularJson(options.publicBaseline, "public-ref baseline");
    const result = buildBaselineSupersession({
      root: options.root,
      legacy: legacy.value,
      legacySha256: legacy.sha256,
      publicBaseline: publicBaseline.value,
      publicBaselineSha256: publicBaseline.sha256,
      legacyPath: relative(options.root, options.legacyCopy),
      publicPath: relative(options.root, options.publicBaseline),
    });
    writeFileSync(options.legacyCopy, legacy.bytes, { mode: 0o600 });
    writeFileSync(options.supersession, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "BLOCKED_NEW_PUBLIC_HISTORY_FINDING") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`public-history baseline migration FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
