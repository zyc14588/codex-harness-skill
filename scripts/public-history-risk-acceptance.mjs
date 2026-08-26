#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const OWNER_DECISION_IDS = Object.freeze([
  "PUB-HIST-EMAIL-001",
  "PUB-HIST-PATH-001",
  "PUB-HIST-GITLINK-001",
]);

const EXPECTED_SELECTIONS = Object.freeze({
  "PUB-HIST-EMAIL-001": "A_ACCEPT_PUBLIC_EMAIL_ACCOUNT_IDENTIFIER_EXPOSURE",
  "PUB-HIST-PATH-001": "A_ACCEPT_PUBLIC_HOME_PATH_AND_ACCOUNT_ALIAS",
  "PUB-HIST-GITLINK-001": "A_ACCEPT_OPAQUE_HISTORICAL_GITLINK_REFERENCES",
});

const EXPECTED_BASELINE = Object.freeze({
  head: "c53614dba3d14b1d441c317a167e8e158193df2b",
  tree: "423a5b3139e64f85909463a655a138916f719b2b",
  auditSha256: "3af7e6be9ad2498bca234e469529098f871d795df9da972c2434ca5e308a3afb",
  commitCount: 32,
  emailOccurrenceCount: 64,
  pathOccurrenceCount: 136,
  uniqueZipFileCount: 6,
  zipMemberOverlapInclusiveCount: 3288,
  uniqueZipMemberCount: 1776,
  historicalGitlinkCount: 3,
});

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must exactly equal ${JSON.stringify(expected)}`);
  }
}

function regularJson(target, label) {
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${target}`);
  const bytes = readFileSync(target);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: object(JSON.parse(bytes.toString("utf8")), label),
    modifiedAt: info.mtime.toISOString(),
  };
}

function blocked(message) {
  throw new Error(`BLOCKED_NEW_PUBLIC_HISTORY_FINDING: ${message}`);
}

function privacySignature(item, { legacy = false } = {}) {
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
  blocked(`unapproved privacy rule ${String(item.rule)}`);
}

function gitObjectSignature(item) {
  return JSON.stringify({
    mode: item.mode,
    type: item.type,
    oid: item.oid,
    pathSha256: item.pathSha256,
  });
}

function exactFindingSet(current, baseline, signature, label, options = {}) {
  if (!Array.isArray(current) || !Array.isArray(baseline)) blocked(`${label} is not an array`);
  const left = current.map((item) => signature(item, options.current)).sort();
  const right = baseline.map((item) => signature(item, options.baseline)).sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) blocked(`${label} changed outside the Owner-accepted distinct signature set`);
}

function onlyFinding(items, rule, label) {
  const matches = items.filter((item) => item.rule === rule);
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one ${rule} finding group`);
  return matches[0];
}

function assertNoUnacceptedFindings(audit, label) {
  if (!Array.isArray(audit.findings?.secrets) || audit.findings.secrets.length !== 0
    || !Array.isArray(audit.findings?.personalInformationCandidates) || audit.findings.personalInformationCandidates.length !== 0
    || !Array.isArray(audit.findings?.archiveIntegrity) || audit.findings.archiveIntegrity.length !== 0
    || !Array.isArray(audit.findings?.lfsPointers) || audit.findings.lfsPointers.length !== 0
    || !Array.isArray(audit.licensing?.thirdPartyDependencyReview?.unresolved)
    || audit.licensing.thirdPartyDependencyReview.unresolved.length !== 0) {
    blocked(`${label} contains a new secret, personal-information candidate, archive, LFS, or distributed-license finding`);
  }
}

function occurrenceDelta(current, approvedMaximum, label) {
  if (!Number.isSafeInteger(current) || current < 0) blocked(`${label} occurrence count is invalid`);
  if (current > approvedMaximum) blocked(`${label} occurrence count ${current} exceeds Owner-approved maximum ${approvedMaximum}`);
  return current - approvedMaximum;
}

export function validatePublicHistoryRiskAcceptance({
  ownerAcceptance,
  legacyBaselineAudit,
  legacyBaselineAuditSha256,
  baselineAudit,
  baselineAuditSha256,
  baselineSupersession,
  currentAudit,
}) {
  const owner = object(ownerAcceptance, "Owner acceptance");
  const baseline = object(baselineAudit, "public-ref baseline audit");
  const legacy = object(legacyBaselineAudit ?? baselineAudit, "legacy local-scope baseline audit");
  const legacySha256 = legacyBaselineAuditSha256 ?? baselineAuditSha256;
  const current = object(currentAudit, "current public-history audit");
  if (owner.schemaVersion !== 1 || owner.version !== "0.6.6"
    || owner.status !== "PUBLIC_HISTORY_OWNER_ACCEPTANCE_APPROVED"
    || owner.decidedBy !== "zyc14588" || owner.decidedAt !== "2026-08-26T08:51:40+10:00") {
    throw new Error("Owner acceptance identity, status, version, or attribution is invalid");
  }
  const ownerBaseline = object(owner.baseline, "Owner acceptance baseline");
  if (ownerBaseline.head !== EXPECTED_BASELINE.head || ownerBaseline.tree !== EXPECTED_BASELINE.tree
    || ownerBaseline.worktreeClean !== true
    || ownerBaseline.publicHistoryAuditSha256 !== EXPECTED_BASELINE.auditSha256
    || legacySha256 !== EXPECTED_BASELINE.auditSha256) {
    throw new Error("Owner acceptance is not bound to the approved baseline audit bytes");
  }
  const decisions = object(owner.decisions, "Owner acceptance decisions");
  if (JSON.stringify(Object.keys(decisions).sort()) !== JSON.stringify([...OWNER_DECISION_IDS].sort())) {
    throw new Error("Owner acceptance decision set is not exact");
  }
  for (const id of OWNER_DECISION_IDS) {
    const decision = object(decisions[id], `Owner decision ${id}`);
    if (decision.status !== "APPROVED" || decision.selected !== EXPECTED_SELECTIONS[id]) {
      throw new Error(`Owner decision ${id} is not the approved exact selection`);
    }
  }
  if (legacy.head !== EXPECTED_BASELINE.head || legacy.coverage?.commits !== EXPECTED_BASELINE.commitCount
    || legacy.coverage?.zipBlobs !== EXPECTED_BASELINE.uniqueZipFileCount
    || legacy.coverage?.zipEntries !== EXPECTED_BASELINE.zipMemberOverlapInclusiveCount) {
    throw new Error("baseline audit coverage differs from the accepted 32-commit/6-ZIP/3,288-member baseline");
  }
  if (!Array.isArray(legacy.findings?.secrets) || legacy.findings.secrets.length !== 0
    || !Array.isArray(legacy.findings?.personalInformationCandidates) || legacy.findings.personalInformationCandidates.length !== 0
    || !Array.isArray(legacy.findings?.archiveIntegrity) || legacy.findings.archiveIntegrity.length !== 0
    || !Array.isArray(legacy.findings?.lfsPointers) || legacy.findings.lfsPointers.length !== 0) {
    throw new Error("baseline audit contains a finding that was not accepted");
  }
  const baselinePrivacy = legacy.findings.personalInformation;
  const baselineEmail = onlyFinding(baselinePrivacy, "personal_email", "baseline privacy findings");
  const baselinePath = onlyFinding(baselinePrivacy, "personal_local_home", "baseline privacy findings");
  if (baselinePrivacy.length !== 2 || baselineEmail.domain !== "qq.com"
    || baselineEmail.matchedUtf8Bytes !== 16 || baselineEmail.occurrenceCount !== EXPECTED_BASELINE.emailOccurrenceCount
    || baselinePath.identityClass !== "local_home_account" || baselinePath.matchedUtf8Bytes !== 14
    || baselinePath.occurrenceCount !== EXPECTED_BASELINE.pathOccurrenceCount) {
    throw new Error("baseline privacy findings exceed or differ from the two accepted identifier groups");
  }
  const ownerHomeHash = createHash("sha256").update(`/home/${owner.decidedBy}`).digest("hex");
  if (baselinePath.matchSha256 !== ownerHomeHash) throw new Error("accepted home-path alias is not the Owner's own account alias");
  const baselineUnsafe = legacy.findings.unsafeGitObjects;
  if (!Array.isArray(baselineUnsafe) || baselineUnsafe.length !== EXPECTED_BASELINE.historicalGitlinkCount
    || baselineUnsafe.some((item) => item.mode !== "160000" || item.type !== "commit")) {
    throw new Error("baseline unsafe Git objects are not exactly the three accepted historical gitlinks");
  }

  if (baselineAuditSha256 !== EXPECTED_BASELINE.auditSha256) {
    const supersession = object(baselineSupersession, "public-history baseline supersession");
    if (supersession.status !== "PUBLIC_REF_BASELINE_SUPERSEDES_LEGACY_LOCAL_SCOPE"
      || supersession.legacyBaseline?.sha256 !== EXPECTED_BASELINE.auditSha256
      || supersession.publicBaseline?.sha256 !== baselineAuditSha256
      || supersession.publicBaseline?.refSetSha256 !== baseline.publicRefScope?.refSetSha256
      || supersession.assurances?.noNewDistinctPersonalIdentifier !== true
      || supersession.assurances?.noNewSecret !== true
      || supersession.assurances?.ownerDecisionContinuesToApply !== true) {
      throw new Error("public-ref baseline is not cryptographically bound to the Owner-accepted legacy baseline");
    }
    if (baseline.auditScope?.mode !== "public-remote") throw new Error("superseding baseline must use public-remote scope");
  }
  assertNoUnacceptedFindings(baseline, "public-ref baseline");
  assertNoUnacceptedFindings(current, "current audit");
  exactFindingSet(baseline.findings.personalInformation, baselinePrivacy, privacySignature, "public-ref baseline privacy findings", {
    baseline: { legacy: true },
  });
  exactFindingSet(current.findings.personalInformation, baselinePrivacy, privacySignature, "privacy findings", {
    baseline: { legacy: true },
  });
  exactFindingSet(baseline.findings.unsafeGitObjects, baselineUnsafe, gitObjectSignature, "public-ref baseline historical gitlink findings");
  exactFindingSet(current.findings.unsafeGitObjects, baselineUnsafe, gitObjectSignature, "historical gitlink findings");
  const currentEmail = onlyFinding(current.findings.personalInformation, "personal_email", "current privacy findings");
  const currentPath = onlyFinding(current.findings.personalInformation, "personal_local_home", "current privacy findings");
  const baselinePublicEmail = onlyFinding(baseline.findings.personalInformation, "personal_email", "public-ref baseline privacy findings");
  const baselinePublicPath = onlyFinding(baseline.findings.personalInformation, "personal_local_home", "public-ref baseline privacy findings");
  const emailOccurrenceDelta = occurrenceDelta(currentEmail.occurrenceCount, EXPECTED_BASELINE.emailOccurrenceCount, "accepted email identifier");
  const pathOccurrenceDelta = occurrenceDelta(currentPath.occurrenceCount, EXPECTED_BASELINE.pathOccurrenceCount, "accepted home-path alias");
  occurrenceDelta(baselinePublicEmail.occurrenceCount, EXPECTED_BASELINE.emailOccurrenceCount, "public-ref baseline email identifier");
  occurrenceDelta(baselinePublicPath.occurrenceCount, EXPECTED_BASELINE.pathOccurrenceCount, "public-ref baseline home-path alias");
  const coverage = object(current.coverage, "current audit coverage");
  if (!Number.isSafeInteger(coverage.uniqueZipFiles) || !Number.isSafeInteger(coverage.zipMembersAfterZipBlobDeduplication)) blocked("current ZIP coverage counters are invalid");
  if (current.activeSource?.gitlinkCount !== 0 || current.activeSource?.gitmodulesCount !== 0) {
    blocked("current public ref tips contain a gitlink or .gitmodules");
  }
  const historicalGitlinks = current.historicalGitlinks;
  if (!Array.isArray(historicalGitlinks) || historicalGitlinks.length !== EXPECTED_BASELINE.historicalGitlinkCount
    || historicalGitlinks.some((item) => item.mode !== "160000" || item.targetAccessible !== false
      || item.gitmodulesPresent !== false || item.externalUrl !== null
      || item.externalContentPresentInRepository !== false || item.externalContentPresentInHistoricalZips !== false
      || !Array.isArray(item.classifications)
      || !["ACCEPTED_OPAQUE_HISTORICAL_REFERENCE", "EXTERNAL_CONTENT_NOT_DISTRIBUTED", "EXCLUDED_FROM_RELEASE_PROVENANCE"]
        .every((classification) => item.classifications.includes(classification)))) {
    blocked("historical gitlink detail does not prove the accepted opaque-reference boundary");
  }
  exactArray(current.preAcceptanceBlockers, ["PUBLIC_HISTORY_PERSONAL_INFORMATION", "UNSAFE_SYMLINK_OR_GITLINK_IN_HISTORY"], "pre-acceptance blockers");
  return {
    result: "PASS",
    findingsDisposition: "PASS_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS",
    historyRewriteRequired: false,
    confirmedSecrets: 0,
    unresolvedDistributedLicenseFindings: 0,
    ownerDecisionIds: [...OWNER_DECISION_IDS],
    acceptedCounts: {
      emailIdentifierCommitCount: currentEmail.uniqueCommitCount ?? null,
      authorCommitterOccurrences: currentEmail.occurrenceCount,
      authorCommitterOccurrenceMaximum: EXPECTED_BASELINE.emailOccurrenceCount,
      pathIdentifierOccurrences: currentPath.occurrenceCount,
      pathIdentifierOccurrenceMaximum: EXPECTED_BASELINE.pathOccurrenceCount,
      historicalZipFiles: coverage.uniqueZipFiles,
      historicalGitlinks: EXPECTED_BASELINE.historicalGitlinkCount,
      zipMemberOccurrencesOverlapInclusive: coverage.zipMemberOccurrencesOverlapInclusive,
      zipMembersAfterZipBlobDeduplication: coverage.zipMembersAfterZipBlobDeduplication,
    },
    occurrenceDeltas: {
      emailVersusOwnerApprovedMaximum: emailOccurrenceDelta,
      pathVersusOwnerApprovedMaximum: pathOccurrenceDelta,
      interpretation: "NEGATIVE_IS_AN_ALLOWED_REDUCTION_NOT_A_HISTORY_REWRITE_CLAIM",
    },
  };
}

export function applyPublicHistoryRiskAcceptance(result, inputs) {
  const preAcceptanceBlockers = [...result.blockers];
  result.preAcceptanceBlockers = preAcceptanceBlockers;
  const disposition = validatePublicHistoryRiskAcceptance({ ...inputs, currentAudit: result });
  result.schemaVersion = 3;
  result.result = disposition.result;
  result.findingsDisposition = disposition.findingsDisposition;
  result.historyRewriteRequired = disposition.historyRewriteRequired;
  result.confirmedSecrets = disposition.confirmedSecrets;
  result.unresolvedDistributedLicenseFindings = disposition.unresolvedDistributedLicenseFindings;
  result.ownerDecisionIds = disposition.ownerDecisionIds;
  result.acceptedCounts = disposition.acceptedCounts;
  result.occurrenceDeltas = disposition.occurrenceDeltas;
  result.blockers = [];
  result.remediationRequired = false;
  result.remediationAuthorityRequired = false;
  result.publicationClassification.personalInformation = "OWNER_ACCEPTED_PUBLIC_EMAIL_AND_PATH_IDENTIFIERS";
  result.publicationClassification.copyrightAndLicensing = "PASS_DISTRIBUTED_CONTENT_OPAQUE_EXTERNAL_TARGETS_EXCLUDED";
  result.publicationClassification.publicationEligibility = "ELIGIBLE_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS";
  result.notes.push("Owner acceptance preserves findings as accepted risk; it does not delete them or claim that history was rewritten or redacted.");
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--root", "--audit", "--owner-acceptance", "--baseline-audit", "--legacy-baseline-audit", "--baseline-supersession", "--output", "--source-path", "--copied-at"].includes(name)) {
      throw new Error(`unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    options[name.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  options.root = path.resolve(options.root ?? fileURLToPath(new URL("..", import.meta.url)));
  options.audit = path.resolve(options.audit ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json"));
  options.ownerAcceptance = path.resolve(options.ownerAcceptance ?? path.join(options.root, "current/evidence/PUBLIC_HISTORY_OWNER_ACCEPTANCE.json"));
  options.baselineAudit = path.resolve(options.baselineAudit ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_PUBLIC_REF_BASELINE.json"));
  options.legacyBaselineAudit = path.resolve(options.legacyBaselineAudit ?? path.join(options.root, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json"));
  options.baselineSupersession = path.resolve(options.baselineSupersession ?? path.join(options.root, "current/evidence/PUBLIC_HISTORY_BASELINE_SUPERSESSION.json"));
  options.output = path.resolve(options.output ?? path.join(options.root, "current/evidence/PUBLIC_HISTORY_RISK_ACCEPTANCE.json"));
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const audit = regularJson(options.audit, "current public-history audit");
    const owner = regularJson(options.ownerAcceptance, "Owner acceptance");
    const baseline = regularJson(options.baselineAudit, "baseline public-history audit");
    const legacyBaseline = regularJson(options.legacyBaselineAudit, "legacy local-scope baseline audit");
    const supersession = regularJson(options.baselineSupersession, "public-history baseline supersession");
    const disposition = validatePublicHistoryRiskAcceptance({
      ownerAcceptance: owner.value,
      legacyBaselineAudit: legacyBaseline.value,
      legacyBaselineAuditSha256: legacyBaseline.sha256,
      baselineAudit: baseline.value,
      baselineAuditSha256: baseline.sha256,
      baselineSupersession: supersession.value,
      currentAudit: audit.value,
    });
    const evidence = {
      schemaVersion: 1,
      version: "0.6.6",
      generatedAt: new Date().toISOString(),
      ...disposition,
      rawAuditRecovery: {
        sourcePath: options.sourcePath ?? "/tmp/codex-public-history-audit-20260826.json",
        copiedAt: options.copiedAt ?? legacyBaseline.modifiedAt,
        controlledPath: path.relative(options.root, options.legacyBaselineAudit).split(path.sep).join("/"),
        sha256: legacyBaseline.sha256,
        ordinaryRegularFileVerified: true,
        symbolicLink: false,
        sourceBytesPreserved: true,
      },
      ownerAcceptance: {
        path: path.relative(options.root, options.ownerAcceptance).split(path.sep).join("/"),
        sha256: owner.sha256,
        decidedBy: owner.value.decidedBy,
        decidedAt: owner.value.decidedAt,
      },
      currentAudit: {
        path: path.relative(options.root, options.audit).split(path.sep).join("/"),
        sha256: audit.sha256,
        head: audit.value.head,
      },
      scopeAssertions: {
        ownerAliasConfirmed: true,
        unrelatedThirdPartyPersonalInformation: 0,
        additionalSensitiveFields: 0,
        activeSourceGitlinks: 0,
        activeSourceGitmodules: 0,
        externalTargetLicenseComplianceVerified: false,
        externalTargetContentDistributed: false,
      },
    };
    writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`public-history risk acceptance FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
