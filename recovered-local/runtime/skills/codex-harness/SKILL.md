---
name: codex-harness
description: Use the controller-gated Codex↔DeepSeek Harness bridge with adaptive split memory, parallel minimal Harness leaves, progressive tool disclosure, token-only model-use gates, and controlled llama.cpp fallback.
---

# Codex-Harness R6.4 controlled workflow

## Authority

Codex is the sole controller, decomposer, reviewer, verifier, and integration decision-maker. Harness and llama.cpp execute only frozen leaves. Never delegate an unconstrained project goal, and never accept a worker summary as evidence.

## Required decomposition sequence

1. Inspect repository governance and require a clean original worktree.
2. Freeze interfaces, acceptance criteria, verification commands, base commit, dependencies, and mutually exclusive write leases.
3. Give each candidate a stable semantic `taskFamily`. Avoid sharing one broad family across unrelated leaves.
4. Call `controller_split_advice` before `controller_plan_create`.
5. Compare the proposed complexity and token gates with memory recommendations.
6. Follow a mature recommendation unless current repository evidence justifies a concrete `memoryOverrideReason`.
7. Prefer `harnessMode=minimal`. Use standard mode only when the frozen task needs a capability that minimal mode cannot safely disclose.
8. Put independent leaves in a `parallelGroup`; express actual ordering with `dependsOn`.
9. Launch all dependency-ready, disjoint leaves up to controller concurrency limits. Continue the Codex lane on disjoint paths.

## Model-tier policy

- Harness + `deepseek-v4-pro` may receive a bounded `large` leaf.
- Harness + `deepseek-v4-flash` is limited to `trivial` / `small` / `medium`.
- llama.cpp is limited to exact-file `trivial` / `small` work with bounded context and structured complete-file output.
- `auto + large` is prohibited.
- A Pro complex leaf may use `ceilingPolicy=unbounded` relative to the normal operator maximum, but it must still freeze finite hard input/output token gates.

## Adaptive split memory

The plan’s `splitDecision` is immutable evidence of what history recommended and what Codex chose. After execution, review, and verification, Bridge records stage-specific outcomes.

Treat these as task-shape shrink signals: input/output token gate exceeded, timeout, execution/scope/orphan failure, fallback, repair, review revise/reject, verification failure. Stable low-utilization success may support conservative growth.

Do **not** shrink task advice for `tool_protocol`, `minimal_tool_plane`, `provider_transport`, or `no_effect`. These are Bridge/Harness infrastructure failures. An implementation/test/repair leaf with a write lease and an empty diff is never a successful sample. Preserve evidence and stop the leaf. R6.0 schema-v1 and R6.1 schema-v2 profiles are legacy evidence and must not constrain R6.4 advice. R6.2/R6.3 schema-v3 infrastructure events may remain visible, but their `tool_protocol`, `minimal_tool_plane`, `provider_transport`, or `no_effect` attribution must not change task-shape recommendations.

Do not manually edit memory during an active task. Do not let Harness write memory. Use `controller_split_memory` to inspect profiles.

## Budget governance

**Cumulative input tokens and output tokens are the only model-use budget gates.**

- `maxInputTokens`: hard cumulative input gate.
- `maxOutputTokens`: hard cumulative output gate.
- `maxApiCalls`, `maxCostCny`, and `maxCostUsd`: reference/alert thresholds only.
- Runtime timeout, cancellation, scope, Git safety, provenance, and output-shape checks remain separate hard governance controls.
- Web budget changes apply to subsequent checks and do not rewrite prior usage.
- Manual CNY reconciliation is append-only and never grants execution permission.

## Progressive minimal tools

Minimal Harness starts with persistent shell/editor plus `capability_catalog` and `capability_enable`. Enable only capabilities listed in the leaf contract:

- `repository_read`: bounded read/search;
- `verification`: frozen command index only;
- `git_inspect`: read-only status/diff.

A disclosure request is not permission to broaden scope. Reject unlisted capabilities and continue only with the frozen lease.

## Completion sequence

For every leaf independently:

1. Poll `harness_status`; inspect executor, model, mode, attempts, Token totals, reference alerts, `minimalMutationAuxiliaryBypassCount/Kinds`, `minimalMutationForceCount`, `minimalMutationPolicyVersion`, forced tools, `toolProtocolRecoveryCount`, native tool-call evidence, `toolProtocolFailure`, `infrastructureFailureKind`, and memory outcome.
2. Reject scope, Git, provenance, cancellation, orphan, Token-gate, tool-protocol, or minimal-tool-plane failures. A recognized `session_title_auxiliary` bypass is not a construction attempt and must not fail the leaf; the following primary request must still disclose a core mutation tool and may force non-thinking `tool_choice=required`. This is protocol evidence only. A recovered DSML/Markdown/textual call is acceptable only when the proxy reports the recovery kind and disclosed tool name and the resulting diff independently proves execution. When recovery count is zero, inspect native structured-call evidence rather than inferring it.
3. Run `harness_collect`.
4. Call `harness_read_changed_file` for every changed path.
5. Record exactly one `controller_review_task` decision.
6. A repair is allowed only after `revise` and shares the original budget group.
7. After approval, run `harness_verify`; reviewed/current/verified fingerprints must match.
8. Use `harness_commit` only after verification PASS. It creates a local branch commit and never merges or pushes.
9. Integrate deliberately, rerun receiving-branch checks, finalize with evidence, then clean worktrees.

## llama.cpp fallback

Eligible local operational failures may restore the exact pre-local file snapshot and fall back to Harness + pinned `deepseek-v4-flash`. Never fall back for Token gate exceeded, scope/Git safety failure, cancellation, or contract violation.

## Prohibitions

No overlapping leases, root-wide or `.git` leases, path traversal, worker staging/commit/merge/rebase/cherry-pick/push/tag, symlink/gitlink creation, automatic integration, credential exposure, proxy-token persistence, or bypass of review/verification/fingerprint/Token gates.
