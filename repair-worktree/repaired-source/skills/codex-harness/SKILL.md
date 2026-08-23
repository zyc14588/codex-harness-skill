---
name: codex-harness
description: Use the controller-gated Codex↔DeepSeek Harness bridge with adaptive split memory, parallel minimal Harness leaves, progressive tool disclosure, token-only model-use gates, and controlled llama.cpp fallback.
---

# Codex-Harness 0.6.5 controlled workflow

## Authority

Codex is the sole controller, decomposer, reviewer, verifier, and integration decision-maker. Harness and llama.cpp execute only frozen leaves. Never delegate an unconstrained project goal, and never accept a worker summary as evidence.

Before controlled use, require `release-status.json` to report `stable`, `controlledUseAllowed=true`, `deliverableStatus=DELIVERABLE_PASS`, and every gate exactly `PASS`. A candidate is installable only for explicit audit with `--audit-candidate`; a withdrawn build is never installable.

Every Harness attempt must run inside the Bridge-created Bubblewrap user/PID/network/mount boundary. Harness receives a per-task proxy token, never the real Provider key; Provider authorization is replaced only by the authenticated local Broker. Do not inherit parent credentials or proxy variables, mount the host DSH home, track `.env*`, put prompt text in argv, or bypass the prompt-file and Unix-socket relay paths. Dashboard/API access requires the operator bearer token; origin/CSRF checks remain mandatory for mutations.

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

Every Harness execution attempt freezes one immutable Provider policy before its process starts:

- Minimal Flash stays `thinking.type=disabled` for every request in the attempt and omits `reasoning_effort`. A diff must never switch it back to thinking mode.
- Pro stays `thinking.type=enabled` with `reasoning_effort=high` and omits `tool_choice` for every request.
- For every Pro assistant tool-call response, retain the exact non-empty Provider `reasoning_content` in conversation history. Later requests must replay that full assistant message unchanged.
- Never invent, blank, summarize, or strip `reasoning_content`, and never delete its tool-call history. A mode mismatch or incomplete replay must fail before Provider I/O with zero new token usage.
- `enabled-thinking Provider tool call omitted non-empty reasoning_content` is a deterministic `provider_protocol` failure. Abort that immutable attempt, block every later Provider request for it, terminate the verified Harness process group, preserve redacted evidence, and do not shrink split-memory advice.

## Adaptive split memory

The plan’s `splitDecision` is immutable evidence of what history recommended and what Codex chose. After execution, review, and verification, Bridge records stage-specific outcomes.

Treat these as task-shape shrink signals: input/output token gate exceeded, timeout, execution/scope/orphan failure, fallback, repair, review revise/reject, verification failure. Stable low-utilization success may support conservative growth.

Do **not** shrink task advice for `tool_protocol`, legacy `minimal_tool_plane`, `minimal_tool_plane_composition`, `minimal_tool_serialization_mismatch`, `thinking_policy_state`, `thinking_replay_state`, `provider_protocol`, `provider_transport`, or `no_effect`. These are Bridge/Harness infrastructure failures. An implementation/test/repair leaf with a write lease and an empty diff is never a successful sample. Preserve evidence and stop the leaf. Split-memory schema v5 quarantines all earlier profiles, including schema-v3 Provider-protocol pollution and schema-v4 zero-I/O managed-MCP startup pollution. A zero-sample infrastructure-only v5 profile is diagnostic state and must retain the caller's proposed scale, complexity, and token gates.

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

1. Poll `harness_status`; inspect executor, model, mode, attempts, Token totals, reference alerts, `minimalRequestPhase`, runner/assembled tool snapshots, redacted per-request evidence, `minimalMutationAuxiliaryBypassCount/Kinds`, `minimalMutationForceCount`, policy version, forced tools, `toolProtocolRecoveryCount`, native tool-call evidence, `toolProtocolFailure`, `infrastructureFailureKind`, and memory outcome.
2. Reject scope, Git, provenance, cancellation, orphan, Token-gate, tool-protocol, composition, serialization, thinking-policy, replay, Provider-protocol, or transport failures. Confirm every request belongs to the frozen attempt policy. For Pro, compare replay-requirement count and replayed ordinals on each request and require real Provider-derived SHA-256/length evidence. A runner-recorded auxiliary bypass is not a construction attempt and must be classified before mutation policy; the following primary request must show identical runner, assembled, adapter, wire, and proxy-parsed tool catalogs before the proxy may force non-thinking `tool_choice=required`. A recovered DSML/Markdown/textual call is acceptable only when the proxy reports the recovery kind and disclosed tool name and the resulting diff independently proves execution. When recovery count is zero, inspect native structured-call evidence rather than inferring it.
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
