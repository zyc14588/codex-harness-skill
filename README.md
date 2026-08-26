# Codex-Harness Bridge repository

The only active source is [`current/`](current/). Historical handoffs, withdrawn releases, fixtures, and prior evidence are retained under [`archive/`](archive/) and are not release inputs.

```text
Version: 0.6.6
Status: candidate / PUBLIC_HISTORY_ACCEPTED_LOCAL_QUALIFICATION_PASS_EXTERNAL_AND_HOST_BLOCKED
Controlled use: false
Branch: repair/0.6.6-public-history-owner-acceptance-r2
Implementation commit: cabf226a8b385732d2249a8af920d20f641aa2a6
Candidate path: 0.6.6-candidate-cabf226a8b38
Final archive: null
```

All four Owner decisions are approved. DEC-002, DEC-003, and DEC-004 are locally implementation-verified. The full all-refs/all-history audit now passes with three exact Owner-accepted historical finding classes: the Owner's email identifier, the Owner's home-path alias, and three opaque historical Gitlinks. No history rewrite is required. Active source and package/archive gates require zero Gitlinks and zero `.gitmodules`. DEC-001 remains incomplete only because required-check branch governance is not configured or verified.

The exact implementation passes 21 local qualification steps with 147 unique tests and 8 gate executions. A separate negative smoke reruns 34 tests. Coverage includes process E2E, the pinned Harness fixture, stdio MCP, security acceptance, negative isolation/resource tests, public-history acceptance, zero-Gitlink structure gates, manifests, and the commit-suffixed candidate install/migration/rollback/reinstall/uninstall lifecycle. The host probe covered all four approved resource profiles, but delegated cgroup v2 I/O is unavailable. A reversible host reconfiguration plan is ready; no privileged command or system-file change was performed. Provider qualification stopped before credential or network I/O (`providerRequestsSent=0`, input/output tokens `0/0`).

This remains a candidate and controlled use is forbidden. The current branch has not been pushed; exact-tip CI and the protected Provider artifact/attestation have not run. The repository is public, but `main` has no branch protection, required checks, or ruleset. No merge, push, tag, GitHub Release, host mutation, or final archive was performed.

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
