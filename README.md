# Codex-Harness Bridge repository

The only active source is [`current/`](current/). Historical handoffs, withdrawn releases, fixtures, and prior evidence are retained under [`archive/`](archive/) and are not release inputs.

```text
Version: 0.6.6
Status: candidate / OWNER_DECISIONS_IMPLEMENTED_LOCAL_PASS_EXTERNAL_BLOCKED
Controlled use: false
Branch: repair/0.6.6-owner-decisions-and-r2-remediation
Implementation commit: 2ea556dc35d3695be3c5b7bad1b3dc86f07156c5
Candidate path: 0.6.6-candidate-2ea556dc35d3
Final archive: null
```

All four Owner decisions are approved. DEC-003 and DEC-004 are locally implementation-verified. DEC-001 remains blocked because the full all-refs/all-history audit found hash-redacted personal information and historical Gitlinks; DEC-002 therefore remains blocked on its required public-history-audit prerequisite. The audit found no confirmed secrets, privacy candidates requiring manual classification, Git LFS gap, archive integrity issue, oversized object, or unresolved current dependency license.

The exact implementation passes 14 local qualification steps and 241 tests, including the complete process E2E, pinned real Harness fixture, stdio MCP, security acceptance, negative isolation/resource tests, and commit-suffixed candidate install/migration/rollback/reinstall/uninstall lifecycle. The host probe covered all four approved resource profiles, but delegated cgroup v2 I/O is unavailable, so controlled Provider qualification stopped before credential or network I/O (`providerRequestsSent=0`).

This is not a stable or controlled-use release. The current implementation has not been pushed; exact-tip CI and the protected Provider artifact/attestation have not run. The repository is public, but `main` has no branch protection, required checks, or ruleset. No merge, push, tag, GitHub Release, or final archive was performed.

Start with [`README_FIRST_ZH.md`](README_FIRST_ZH.md). Machine authority is [`current/release-status.json`](current/release-status.json), with provenance in [`current/SOURCE_PROVENANCE.json`](current/SOURCE_PROVENANCE.json), decisions in [`current/docs/OWNER_DECISIONS.json`](current/docs/OWNER_DECISIONS.json), and the publication audit in [`current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json`](current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json).

```bash
cd current
node scripts/verify-release-gate.mjs --root . --audit-candidate
cd bridge
npm ci
npm run build
npm test
```

Automatic merge, push, tag, or release is forbidden. A remote mutation requires separate explicit user authorization.
