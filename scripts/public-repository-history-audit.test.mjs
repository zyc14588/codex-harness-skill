import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditPublicRepository } from "./public-repository-history-audit.mjs";
import { validatePublicHistoryRiskAcceptance } from "./public-history-risk-acceptance.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("public audit finds deleted historical secrets and commit PII without emitting their values", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "public-history-audit-"));
  const secret = ["ghp", "A".repeat(40)].join("_");
  const personalEmail = ["owner.audit", "mail.test.invalid"].join("@").replace(".invalid", ".example.co");
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Audit Fixture"]);
    git(root, ["config", "user.email", "audit@example.invalid"]);
    writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
    writeFileSync(path.join(root, "historical.txt"), `${secret}\n`);
    git(root, ["add", "LICENSE", "historical.txt"]);
    git(root, ["commit", "-qm", "historical secret fixture"]);
    git(root, ["rm", "-q", "historical.txt"]);
    git(root, ["commit", "-qm", "remove historical secret"]);
    git(root, ["config", "user.email", personalEmail]);
    writeFileSync(path.join(root, "README.md"), "current worktree is otherwise clean\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "personal metadata fixture"]);

    const result = auditPublicRepository({ root });
    assert.equal(result.result, "BLOCKED_PUBLIC_HISTORY_REMEDIATION");
    assert.ok(result.blockers.includes("HISTORICAL_OR_CURRENT_SECRET_MATERIAL"));
    assert.ok(result.blockers.includes("PUBLIC_HISTORY_PERSONAL_INFORMATION"));
    assert.ok(result.coverage.commits >= 3);
    assert.ok(result.findings.secrets.some((item) => item.locator.includes("historical.txt")));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(personalEmail), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public audit binds but does not content-scan its current evidence file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "public-history-audit-self-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Audit Fixture"]);
    git(root, ["config", "user.email", "audit@example.invalid"]);
    mkdirSync(path.join(root, "current/evidence"), { recursive: true });
    writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
    git(root, ["add", "LICENSE"]);
    git(root, ["commit", "-qm", "audit fixture baseline"]);
    writeFileSync(
      path.join(root, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json"),
      `${["ghp", "A".repeat(40)].join("_")}\n`,
    );
    git(root, ["add", "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json"]);

    const result = auditPublicRepository({ root });
    assert.equal(result.findings.secrets.length, 0);
    assert.equal(result.coverage.selfEvidenceContentExclusions, 1);
    assert.equal(result.coverage.trackedWorktreePaths, 2);
    assert.match(result.worktree.trackedPathSetSha256, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Owner acceptance closes only the exact baseline findings and rejects additions", () => {
  const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const baselineBytes = readFileSync(path.join(repositoryRoot, "current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json"));
  const baselineAudit = JSON.parse(baselineBytes.toString("utf8"));
  const ownerAcceptance = JSON.parse(readFileSync(path.join(repositoryRoot, "current/evidence/PUBLIC_HISTORY_OWNER_ACCEPTANCE.json"), "utf8"));
  const currentAudit = structuredClone(baselineAudit);
  currentAudit.coverage = {
    ...currentAudit.coverage,
    uniqueZipFiles: 6,
    zipMemberOccurrencesOverlapInclusive: 3288,
    zipMembersAfterZipBlobDeduplication: 1776,
  };
  for (const finding of currentAudit.findings.personalInformation) {
    if (finding.rule === "personal_email") {
      finding.identifierShape = "9_DIGIT_ACCOUNT_IDENTIFIER_AT_QQ_COM";
      finding.uniqueCommitCount = 32;
    } else if (finding.rule === "personal_local_home") finding.uniqueHistoricalZipCount = 6;
  }
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
  const input = {
    ownerAcceptance,
    baselineAudit,
    baselineAuditSha256: createHash("sha256").update(baselineBytes).digest("hex"),
    currentAudit,
  };
  assert.equal(validatePublicHistoryRiskAcceptance(input).result, "PASS");
  currentAudit.findings.secrets.push({ rule: "new-secret" });
  assert.throws(() => validatePublicHistoryRiskAcceptance(input), /new secret/u);
});
