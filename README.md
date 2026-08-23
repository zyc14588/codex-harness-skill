# Codex-Harness Bridge repository

The only active source is [`current/`](current/). Run every build, test, install, release-gate, and packaging command from that directory (or use a root workflow whose `working-directory` is `current`).

```text
Version: 0.6.6
Status: candidate / FINAL_VERSION_QUALIFICATION_IN_PROGRESS
Controlled use: false
Branch: repair/0.6.6-provider-capability-and-release-integrity
```

The former R6.4 handoff, recovered baselines, withdrawn 0.6.5 archives, historical reports, and fixtures are under [`archive/`](archive/). They are evidence only and are not build or install entrypoints.

Start with [`README_FIRST_ZH.md`](README_FIRST_ZH.md), then consult [`current/release-status.json`](current/release-status.json) for machine-readable qualification state. No 0.6.6 stable artifact exists yet; old Provider smokes cannot qualify the changed security path.
