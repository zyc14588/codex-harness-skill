# Codex-Harness Bridge repository

The only active source is [`current/`](current/). Run builds, tests, installs, release gates, and packaging commands there, or through a root workflow whose working directory is `current/`.

```text
Version: 0.6.6
Status: candidate / REPAIR_IMPLEMENTED_EXTERNAL_OWNER_AND_ARCHIVE_GATES_PENDING
Controlled use: false
Branch: repair/0.6.6-pre-release-audit-r1
Implementation commit: 62406f99b7caa8ecb3c8b6deb0d457973f3f9b34
Final archive: null
```

The repaired implementation passed the bound local qualification and negative-smoke suites. Cancellation now reaches Host-side process groups, resource profiles cover the Harness parent and brokered siblings, the release gate uses exact fail-closed gate sets and a non-circular two-stage seal, protected Provider evidence is designed for artifact upload and attestation, and the two P2 output/audit bounds have local coverage.

This is not a stable or controlled-use release. On the current host, every required resource control except the delegated cgroup v2 I/O controller was observed, so the real Provider smoke stopped before sending any Provider request. The current repair branch was pushed under explicit user authorization; the final governance tip still requires an exact-tip GitHub Actions conclusion. A read-only check on 2026-08-25 confirmed that the private repository's branch-protection and rulesets APIs still return HTTP 403 for the current GitHub plan. Protected Provider artifact attestation, owner decisions DEC-001 through DEC-004, seal-ready verification, deterministic archive generation, and unpacked archive revalidation remain pending.

The earlier successful CI run on `repair/0.6.6-provider-capability-and-release-integrity` is historical evidence only and is ineligible for the current seal. No stable ZIP, tag, merge, push, or GitHub Release was created.

Start with [`README_FIRST_ZH.md`](README_FIRST_ZH.md). Machine-readable authority is [`current/release-status.json`](current/release-status.json), with provenance in [`current/SOURCE_PROVENANCE.json`](current/SOURCE_PROVENANCE.json) and pending owner choices in [`current/docs/OWNER_DECISIONS.json`](current/docs/OWNER_DECISIONS.json).

```bash
cd current
node scripts/verify-release-gate.mjs --root . --audit-candidate
cd bridge
npm ci
npm run build
npm test
```

Automatic merge, push, tag, or release is forbidden. The current branch push was performed only in response to explicit user authorization.
