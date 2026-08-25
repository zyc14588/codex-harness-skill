import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditPublicRepository } from "./public-repository-history-audit.mjs";

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
