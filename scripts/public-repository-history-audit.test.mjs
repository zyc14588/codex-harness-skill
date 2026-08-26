import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditPublicRepository } from "./public-repository-history-audit.mjs";
import { withPublicRefScope } from "./public-ref-scope.mjs";
import { validatePublicHistoryRiskAcceptance } from "./public-history-risk-acceptance.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32_000_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFixture() {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "public-ref-audit-test-"));
  const remote = path.join(fixtureRoot, "origin.git");
  const work = path.join(fixtureRoot, "work");
  git(fixtureRoot, ["init", "--bare", "-q", remote]);
  mkdirSync(work);
  git(work, ["init", "-q"]);
  git(work, ["checkout", "-qb", "main"]);
  git(work, ["config", "user.name", "Audit Fixture"]);
  git(work, ["config", "user.email", "audit@example.invalid"]);
  git(work, ["remote", "add", "origin", remote]);
  mkdirSync(path.join(work, "current"));
  writeFileSync(path.join(work, "LICENSE"), "fixture license\n");
  writeFileSync(path.join(work, "current/README.md"), "fixture\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "fixture root"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return {
    fixtureRoot,
    remote,
    work,
    cleanup() { rmSync(fixtureRoot, { recursive: true, force: true }); },
  };
}

function audit(root, extra = {}) {
  return auditPublicRepository({ root, scope: "public-remote", ...extra });
}

function cloneFixture(fixture, name, extra = []) {
  const target = path.join(fixture.fixtureRoot, name);
  git(fixture.fixtureRoot, ["clone", "-q", ...extra, extra.length ? `file://${fixture.remote}` : fixture.remote, target]);
  git(target, ["config", "user.name", "Audit Fixture"]);
  git(target, ["config", "user.email", "audit@example.invalid"]);
  return target;
}

test("public audit finds deleted historical secrets and commit PII without emitting their values", () => {
  const fixture = createFixture();
  const secret = ["ghp", "A".repeat(40)].join("_");
  const personalEmail = ["owner.audit", "mail.example.co"].join("@");
  try {
    writeFileSync(path.join(fixture.work, "historical.txt"), `${secret}\n`);
    git(fixture.work, ["add", "historical.txt"]);
    git(fixture.work, ["commit", "-qm", "historical secret fixture"]);
    git(fixture.work, ["rm", "-q", "historical.txt"]);
    git(fixture.work, ["commit", "-qm", "remove historical secret"]);
    git(fixture.work, ["config", "user.email", personalEmail]);
    writeFileSync(path.join(fixture.work, "current/README.md"), "published metadata fixture\n");
    git(fixture.work, ["add", "current/README.md"]);
    git(fixture.work, ["commit", "-qm", "personal metadata fixture"]);
    git(fixture.work, ["push", "-q", "origin", "main"]);
    const result = audit(fixture.work);
    assert.equal(result.result, "BLOCKED_PUBLIC_HISTORY_REMEDIATION");
    assert.ok(result.blockers.includes("HISTORICAL_OR_CURRENT_SECRET_MATERIAL"));
    assert.ok(result.blockers.includes("PUBLIC_HISTORY_PERSONAL_INFORMATION"));
    assert.ok(result.findings.secrets.some((item) => item.locator.includes("historical.txt")));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(personalEmail), false);
  } finally {
    fixture.cleanup();
  }
});

test("adding refs/stash does not change public audit bytes", () => {
  const fixture = createFixture();
  try {
    const before = JSON.stringify(audit(fixture.work));
    writeFileSync(path.join(fixture.work, "current/README.md"), "stashed local mutation\n");
    git(fixture.work, ["stash", "push", "-qm", "local-only stash"]);
    assert.equal(JSON.stringify(audit(fixture.work)), before);
  } finally { fixture.cleanup(); }
});

test("adding a local-only branch does not change public audit bytes", () => {
  const fixture = createFixture();
  try {
    const before = JSON.stringify(audit(fixture.work));
    git(fixture.work, ["checkout", "-qb", "local-only"]);
    writeFileSync(path.join(fixture.work, "local-only.txt"), "not public\n");
    git(fixture.work, ["add", "local-only.txt"]);
    git(fixture.work, ["commit", "-qm", "local-only commit"]);
    assert.equal(JSON.stringify(audit(fixture.work)), before);
  } finally { fixture.cleanup(); }
});

test("adding a duplicate remote-tracking ref does not change public audit bytes", () => {
  const fixture = createFixture();
  try {
    const before = JSON.stringify(audit(fixture.work));
    const head = git(fixture.work, ["rev-parse", "main"]);
    git(fixture.work, ["update-ref", "refs/remotes/origin/duplicate", head]);
    assert.equal(JSON.stringify(audit(fixture.work)), before);
  } finally { fixture.cleanup(); }
});

test("clean clone and development repository produce the same public audit", () => {
  const fixture = createFixture();
  try {
    const clean = cloneFixture(fixture, "clean");
    git(fixture.work, ["branch", "development-only"]);
    git(fixture.work, ["update-ref", "refs/remotes/origin/duplicate", git(fixture.work, ["rev-parse", "main"])]);
    assert.deepEqual(audit(clean), audit(fixture.work));
  } finally { fixture.cleanup(); }
});

test("new remote branch at an existing commit does not increase commit or PII counts", () => {
  const fixture = createFixture();
  try {
    const before = audit(fixture.work);
    git(fixture.work, ["push", "-q", "origin", "main:refs/heads/alias"]);
    const after = audit(fixture.work);
    assert.equal(after.coverage.commits, before.coverage.commits);
    assert.equal(after.summary.emailOccurrenceCount, before.summary.emailOccurrenceCount);
    assert.equal(after.summary.pathOccurrenceCount, before.summary.pathOccurrenceCount);
    assert.equal(after.summary.publicRefCount, before.summary.publicRefCount + 1);
  } finally { fixture.cleanup(); }
});

test("annotated public tag records and verifies its peeled commit", () => {
  const fixture = createFixture();
  try {
    git(fixture.work, ["tag", "-a", "v1.0.0", "-m", "annotated fixture"]);
    git(fixture.work, ["push", "-q", "origin", "refs/tags/v1.0.0"]);
    const result = audit(fixture.work);
    const tag = result.publicRefScope.refs.find((ref) => ref.name === "refs/tags/v1.0.0");
    assert.match(tag.oid, /^[0-9a-f]{40}$/u);
    assert.equal(tag.peeledOid, git(fixture.work, ["rev-parse", "main"]));
  } finally { fixture.cleanup(); }
});

test("replace refs and grafts in the development repository cannot alter public audit", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.work, "current/README.md"), "second published commit\n");
    git(fixture.work, ["add", "current/README.md"]);
    git(fixture.work, ["commit", "-qm", "second public commit"]);
    git(fixture.work, ["push", "-q", "origin", "main"]);
    const before = audit(fixture.work);
    const parent = git(fixture.work, ["rev-parse", "HEAD^"]);
    const head = git(fixture.work, ["rev-parse", "HEAD"]);
    git(fixture.work, ["replace", parent, head]);
    const gitDirectory = path.resolve(fixture.work, git(fixture.work, ["rev-parse", "--git-dir"]));
    mkdirSync(path.join(gitDirectory, "info"), { recursive: true });
    writeFileSync(path.join(gitDirectory, "info/grafts"), `${head}\n`);
    assert.deepEqual(audit(fixture.work), before);
  } finally { fixture.cleanup(); }
});

test("shallow source clone is completed in the isolated audit repository", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.work, "current/README.md"), "second published commit\n");
    git(fixture.work, ["add", "current/README.md"]);
    git(fixture.work, ["commit", "-qm", "second public commit"]);
    git(fixture.work, ["push", "-q", "origin", "main"]);
    const full = audit(fixture.work);
    const shallow = cloneFixture(fixture, "shallow", ["--depth=1"]);
    const shallowAudit = audit(shallow);
    assert.equal(shallowAudit.isolation.sourceWasShallow, true);
    assert.equal(shallowAudit.isolation.isolatedRepositoryShallow, false);
    assert.equal(shallowAudit.coverage.commits, full.coverage.commits);
    assert.deepEqual(shallowAudit.inventory, full.inventory);
  } finally { fixture.cleanup(); }
});

test("proposed-public-ref adds only the explicit exact local commit", () => {
  const fixture = createFixture();
  try {
    const remoteAudit = audit(fixture.work);
    git(fixture.work, ["checkout", "-qb", "proposal"]);
    writeFileSync(path.join(fixture.work, "proposal.txt"), "explicit proposal\n");
    git(fixture.work, ["add", "proposal.txt"]);
    git(fixture.work, ["commit", "-qm", "explicit proposed commit"]);
    const proposedCommit = git(fixture.work, ["rev-parse", "HEAD"]);
    const proposed = auditPublicRepository({ root: fixture.work, scope: "proposed-public-ref", proposedRef: "refs/heads/proposal", proposedCommit });
    assert.equal(proposed.coverage.commits, remoteAudit.coverage.commits + 1);
    assert.equal(proposed.auditScope.proposedCommit, proposedCommit);
    assert.equal(proposed.publicRefScope.refs.find((ref) => ref.name === "refs/heads/proposal").oid, proposedCommit);
  } finally { fixture.cleanup(); }
});

test("forged ls-remote input fails against the fetched origin ref", () => {
  const fixture = createFixture();
  try {
    const forged = `${"f".repeat(40)}\trefs/heads/main\n`;
    assert.throws(() => withPublicRefScope({ root: fixture.work, scope: "public-remote", testOnlyAdvertisement: forged }, () => null), /forged/u);
  } finally { fixture.cleanup(); }
});

test("two independent public-ref audits are byte-identical", () => {
  const fixture = createFixture();
  try {
    const first = `${JSON.stringify(audit(fixture.work), null, 2)}\n`;
    const second = `${JSON.stringify(audit(fixture.work), null, 2)}\n`;
    assert.equal(second, first);
  } finally { fixture.cleanup(); }
});

function acceptanceFixture() {
  const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const legacyBytes = readFileSync(path.join(repositoryRoot, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json"));
  const legacyBaselineAudit = JSON.parse(legacyBytes.toString("utf8"));
  const ownerAcceptance = JSON.parse(readFileSync(path.join(repositoryRoot, "current/evidence/PUBLIC_HISTORY_OWNER_ACCEPTANCE.json"), "utf8"));
  const baselineAudit = structuredClone(legacyBaselineAudit);
  baselineAudit.auditScope = { mode: "public-remote", proposedRef: null, proposedCommit: null };
  baselineAudit.publicRefScope = { refSetSha256: "f".repeat(64) };
  baselineAudit.coverage = {
    ...baselineAudit.coverage,
    uniqueZipFiles: 6,
    zipMemberOccurrencesOverlapInclusive: 1776,
    zipMembersAfterZipBlobDeduplication: 1776,
  };
  for (const finding of baselineAudit.findings.personalInformation) {
    if (finding.rule === "personal_email") {
      finding.identifierShape = "9_DIGIT_ACCOUNT_IDENTIFIER_AT_QQ_COM";
      finding.uniqueCommitCount = 30;
    } else if (finding.rule === "personal_local_home") finding.uniqueHistoricalZipCount = 6;
  }
  baselineAudit.licensing.thirdPartyDependencyReview.unresolved = [];
  const currentAudit = structuredClone(baselineAudit);
  currentAudit.activeSource = { gitlinkCount: 0, gitmodulesCount: 0 };
  const details = [
    ["bd707c75e7c730773fec3f7716847942f9bf27a5", "repair-worktree/rc1-real-smoke-repo", "05773fb6bee92b6f58f0aae6556b014103eebd24"],
    ["bd707c75e7c730773fec3f7716847942f9bf27a5", "repair-worktree/repaired-source", "d30d9ac678f143e7bb14ea11a55e8b7cdd7152c8"],
    ["dd4714a52aaef93f4645f4f7b3aded491aa95b0b", "repair-worktree/repaired-source", "e2581382415fc167f26d9ce49bb9a6a95a119a04"],
  ];
  currentAudit.historicalGitlinks = details.map(([commit, gitlinkPath, objectId]) => ({
    ref: "refs/heads/main",
    commit,
    path: gitlinkPath,
    mode: "160000",
    type: "commit",
    objectId,
    gitmodulesPresent: false,
    externalUrl: null,
    targetAccessible: false,
    externalContentPresentInRepository: false,
    externalContentPresentInHistoricalZips: false,
    classifications: [
      "ACCEPTED_OPAQUE_HISTORICAL_REFERENCE",
      "EXTERNAL_CONTENT_NOT_DISTRIBUTED",
      "EXCLUDED_FROM_RELEASE_PROVENANCE",
    ],
  }));
  currentAudit.preAcceptanceBlockers = ["PUBLIC_HISTORY_PERSONAL_INFORMATION", "UNSAFE_SYMLINK_OR_GITLINK_IN_HISTORY"];
  return {
    ownerAcceptance,
    legacyBaselineAudit,
    legacyBaselineAuditSha256: createHash("sha256").update(legacyBytes).digest("hex"),
    baselineAudit,
    baselineAuditSha256: createHash("sha256").update(legacyBytes).digest("hex"),
    currentAudit,
  };
}

test("accepted identifier occurrence reduction passes and records a negative delta", () => {
  const input = acceptanceFixture();
  input.currentAudit.findings.personalInformation.find((item) => item.rule === "personal_email").occurrenceCount = 60;
  input.currentAudit.findings.personalInformation.find((item) => item.rule === "personal_local_home").occurrenceCount = 91;
  const result = validatePublicHistoryRiskAcceptance(input);
  assert.equal(result.result, "PASS");
  assert.equal(result.occurrenceDeltas.emailVersusOwnerApprovedMaximum, -4);
  assert.equal(result.occurrenceDeltas.pathVersusOwnerApprovedMaximum, -45);
});

test("accepted identifier occurrence increase above the Owner maximum fails", () => {
  const input = acceptanceFixture();
  input.currentAudit.findings.personalInformation.find((item) => item.rule === "personal_email").occurrenceCount = 65;
  assert.throws(() => validatePublicHistoryRiskAcceptance(input), /BLOCKED_NEW_PUBLIC_HISTORY_FINDING.*exceeds/u);
});

test("new distinct email or home alias fails", () => {
  const emailInput = acceptanceFixture();
  emailInput.currentAudit.findings.personalInformation.push({
    rule: "personal_email",
    matchSha256: "a".repeat(64),
    matchedUtf8Bytes: 18,
    domain: "example.co",
    identifierShape: "OTHER_EMAIL_IDENTIFIER",
    occurrenceCount: 1,
  });
  assert.throws(() => validatePublicHistoryRiskAcceptance(emailInput), /BLOCKED_NEW_PUBLIC_HISTORY_FINDING.*privacy/u);
  const pathInput = acceptanceFixture();
  pathInput.currentAudit.findings.personalInformation.push({
    rule: "personal_local_home",
    matchSha256: "b".repeat(64),
    matchedUtf8Bytes: 12,
    identityClass: "local_home_account",
    occurrenceCount: 1,
  });
  assert.throws(() => validatePublicHistoryRiskAcceptance(pathInput), /BLOCKED_NEW_PUBLIC_HISTORY_FINDING.*privacy/u);
});

test("new secret fails without expanding Owner acceptance", () => {
  const input = acceptanceFixture();
  input.currentAudit.findings.secrets.push({ rule: "new-secret" });
  assert.throws(() => validatePublicHistoryRiskAcceptance(input), /BLOCKED_NEW_PUBLIC_HISTORY_FINDING.*secret/u);
});

test("new Gitlink object/path signature fails", () => {
  const input = acceptanceFixture();
  input.currentAudit.findings.unsafeGitObjects.push({
    mode: "160000",
    type: "commit",
    oid: "c".repeat(40),
    pathSha256: "d".repeat(64),
  });
  assert.throws(() => validatePublicHistoryRiskAcceptance(input), /BLOCKED_NEW_PUBLIC_HISTORY_FINDING.*gitlink/u);
});
