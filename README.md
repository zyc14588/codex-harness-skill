# Codex-Harness Bridge repository

The only active source is [`current/`](current/). Run every build, test, install, release-gate, and packaging command from that directory (or use a root workflow whose `working-directory` is `current`).

```text
Version: 0.6.6
Status: candidate / QUALIFIED_CANDIDATE_EXTERNAL_GATES_PENDING
Controlled use: false
Branch: repair/0.6.6-provider-capability-and-release-integrity
```

The former R6.4 handoff, recovered baselines, withdrawn 0.6.5 archives, historical reports, and fixtures are under [`archive/`](archive/). They are evidence only and are not build or install entrypoints.

Start with [`README_FIRST_ZH.md`](README_FIRST_ZH.md), then consult [`current/release-status.json`](current/release-status.json) for machine-readable qualification state. Bound local and current-revision Provider qualification passed, but no 0.6.6 stable artifact exists: the target is not on the remote and has no Actions run, branch protection is unavailable under the observed private-repository plan (HTTP 403), and final archive revalidation remains blocked.
