# 0.6.5 Stable Repair Worklog

## 2026-08-22T14:29:04+10:00 — Round 2 opened

- Loaded the handoff contract, full original repair prompt, audit, acceptance matrix, provenance, rc.1 smoke report, and redacted raw evidence.
- The requested `CODEX_DELIVERABLE_REPAIR_PROMPT_ZH.md` is not present anywhere under `/home/zyc14588`; the complete launch directive supplied in the current user message is therefore the authoritative continuation contract.
- Confirmed clean repair source at `d30d9ac678f143e7bb14ea11a55e8b7cdd7152c8` and clean real Harness main at `141eb6fef83422698aef7a981029e843e8161534`.
- Preserved rc.1 failure evidence. The observed sequence was disabled, disabled, then enabled within one attempt; request 3 replayed assistant/tool history without provider-supplied `reasoning_content` and DeepSeek rejected it before review/verification/commit.
- Provisional single primary root cause: thinking policy is request-local rather than immutable at attempt scope. Next action is a deterministic failing reproduction that covers immutable Minimal Flash/Pro Thinking policy and missing-replay preflight isolation.

## 2026-08-22T14:33:00+10:00 — Root cause confirmed

- Initial in-sandbox `npm run check` produced two false failures because the sandbox suppresses piped stdout/stderr from nested Node processes. Re-running the unchanged baseline outside that restriction passed all 67 tests. The dependency toolchain was restored from exact locally cached tarballs (`typescript@5.8.3`, `@types/node@22.15.0`, `undici-types@6.21.0`); no network dependency was introduced.
- Added the stable regression `keeps Minimal Flash disabled after a real diff exists within the same attempt`.
- Expected-failure result: 5/6 narrow tests passed; the new test failed because `applyMinimalMutationPolicy()` returned the original request by reference after `changedPaths` became non-empty. The returned request still had `thinking.type=enabled`, `reasoning_effort=high`, and `tool_choice=auto`.
- This exactly reproduces rc.1 request 3 and confirms the primary root cause: request-local policy restoration violates attempt-level thinking immutability.
- Next action: introduce a durable attempt policy, enforce Minimal Flash disabled for every request, enforce Pro enabled/no-tool-choice, validate hashed full `reasoning_content` replay before Provider I/O, and classify all such failures as infrastructure.

## 2026-08-22T14:43:51+10:00 — Minimal fix and narrow verification passed

- Replaced the post-diff request-shape restoration with `minimal-flash-attempt-fixed-v4`: all Minimal Flash mutation requests remain `thinking.type=disabled`, omit `reasoning_effort`, and post-diff requests remove `tool_choice` while restoring the full tool catalog.
- Added an immutable policy snapshot to every new Harness execution attempt. Flash freezes `disabled/off`; Pro freezes `enabled/high`. Model or mode changes are rejected as `thinking_policy_state` before usage accounting and before the Provider POST.
- Added Pro replay integrity tracking. The Bridge persists only SHA-256, UTF-8 length, request ordinal, and tool-call IDs from the real Provider response. Every later request must replay the exact non-empty `reasoning_content` with the complete assistant tool-call history; missing, empty, or altered replay is rejected as `thinking_replay_state` before Provider I/O.
- Provider tool-call responses that omit required reasoning and non-transport HTTP rejections are attributed to `provider_protocol`. All thinking/protocol kinds are isolated from split learning.
- Raised split-memory to schema 4. Schema 3 profiles are conservatively quarantined and archived on the next write, so the rc.1 `INVALID_REQUEST` sample cannot shrink leaf scale, complexity, or token recommendations.
- Narrow build and test result: PASS for Minimal mutation policy, attempt policy/replay integrity, and split-memory schema 4 migration.
- Next action: extend and run dynamic multi-round Harness fixtures, including a missing-replay failure injection that proves zero Provider calls/tokens and unchanged split advice.

## 2026-08-22T14:48:11+10:00 — Dynamic Pro model-route failure preserved

- The expanded managed-profile fixture completed all four Flash Provider rounds with disabled thinking and no wire `reasoning_effort`.
- The Pro task then failed before any Provider call. Its attempt was correctly frozen to `deepseek-v4-pro/enabled/high`, while the actual Harness request selected `deepseek-v4-flash`; the preflight rejected the mismatch as `thinking_policy_state` with 0/0 tokens.
- Evidence: `.repair/evidence/round2-dynamic-pro-model-route-failure.json`.
- Single root cause for this failure: the runner obtains `agentDefaultModel.currentSelection()` after Harness bootstrap, and the worker's `DSH_MODEL=deepseek-v4-pro` environment assignment does not replace that resolved selection.
- Next action: carry the attempt model as an explicit Bridge-owned runner input and freeze agent/model selection to that model before request construction. The strict model mismatch rejection remains unchanged.

## 2026-08-22T14:48:56+10:00 — Dynamic functional gates passed; fixture cleanup failed

- Explicitly routing the runner with the Bridge-owned attempt model fixed Pro selection without weakening preflight enforcement.
- Functional results before cleanup: Flash 4 requests, all disabled with no `reasoning_effort`, 3 native tool calls; Pro 3 enabled/high requests with no `tool_choice`, 2 native tool calls, replay depths 0/1/2; injected missing replay made 0 Provider calls, used 0/0 tokens, and left schema-4 sample count, scale, complexity, and token recommendations unchanged.
- The process still exited nonzero because the manually created injection record remained `running` and therefore correctly blocked temporary worktree cleanup. Evidence: `.repair/evidence/round2-dynamic-functional-pass-cleanup-failure.json`.
- Fix: transition that expected-failure record and its attempt to terminal `failed` after assertions and before fixture cleanup, then rerun the whole fixture.

## 2026-08-22T14:51:00+10:00 — Direct acceptance exposed stale fake-Harness request shape

- After the dynamic fixture passed with a zero exit, the 73-test regression suite passed.
- `npm run direct-acceptance` failed at the first live-usage assertion because its deterministic `scripts/fake-dsh.mjs` still sent generic requests with `tool_choice=auto` and no thinking fields. The production preflight correctly rejected this before usage accounting, leaving no in-flight cost to observe.
- Evidence: `.repair/evidence/round2-direct-acceptance-fixture-policy-failure.json`.
- Root cause is confined to the acceptance simulator. Fix it to consume the Bridge-owned attempt model/effort and serialize the same Flash/Pro request contracts as the managed runner; do not weaken production validation.

## 2026-08-22T14:51:48+10:00 — Direct acceptance reached stale v3 expectation

- After aligning fake Harness request serialization, direct acceptance passed the previously failing in-flight usage gate and continued through the textual tool-call recovery task.
- It stopped only because three assertions still expected the withdrawn `minimal-flash-explicit-purpose-v3` identifier while runtime correctly reported `minimal-flash-attempt-fixed-v4`.
- Evidence: `.repair/evidence/round2-direct-acceptance-version-expectation.json`.
- Updated only those exact-version expectations; all request-shape, tool execution, scope, review, verification, and fingerprint assertions remain intact.

## 2026-08-22T14:55:00+10:00 — Default Flash split-key alias corrected

- The rc.2 direct acceptance rerun reached adaptive memory and found the prior token-gate sample under an explicit `deepseek-v4-flash` key, while `controllerSplitAdvice` queried the old `default` alias and returned sample count 0.
- Evidence: `.repair/evidence/round2-default-flash-split-key-failure.json`.
- Root cause: default model freezing was correct for attempt safety but not yet canonicalized across every split-memory caller.
- Fix: omitted Harness model and explicit `deepseek-v4-flash` now hash to the same memory tier; controller advice also resolves the default to Flash. Added a stable key-equivalence regression.

## 2026-08-22T14:59:55+10:00 — Infrastructure-only token baseline drift preserved

- Direct acceptance advanced past the default-Flash key regression, then found that an infrastructure-only profile with `sampleCount=0` changed advice from the caller's `20000/4000` proposal to the failed task's `10000/2000` gates.
- Evidence: `.repair/evidence/round2-infrastructure-only-budget-drift.json`.
- Single root cause: `initialProfile` necessarily records the failed task's gates, while `adviseSplit` consumed those fields even with no learnable task-shape sample.
- Minimal fix: zero-sample profiles retain their infrastructure diagnostics but advice uses the current caller proposal for both token gates. The existing infrastructure regression now deliberately uses different event and proposal budgets.
- Next action: run the narrow split-memory test, full regression, and direct acceptance.

## 2026-08-22T15:01:22+10:00 — Split baseline repair verified

- Narrow split-memory regression: PASS, 7/7.
- Complete regression: PASS, 74/74.
- Direct acceptance: PASS for `0.6.5-rc.2`, including adaptive memory, infrastructure isolation, native tool execution, required-tool fail-closed behavior, review/verification/fingerprint gates, local commits, cleanup, and managed Harness lifecycle.
- Next action: rerun the dynamic four-round Flash, multi-round Pro replay, and missing-replay failure-injection fixture against the rebuilt artifacts.

## 2026-08-22T15:01:52+10:00 — Dynamic multi-turn and failure-injection gate passed

- Managed-profile Flash: PASS, four Provider requests in one attempt; every request was `thinking.type=disabled`, omitted `reasoning_effort`, and the task executed three native tool calls.
- Managed-profile Pro: PASS, three Provider requests in one attempt; every request was enabled/high with no `tool_choice`; two Provider tool-call messages supplied non-empty reasoning hashes and were replayed at depths 0/1/2.
- Missing-replay injection: PASS with HTTP 502 before Provider I/O, `thinking_replay_state`, Provider calls 0, input/output tokens 0/0, sample count 0, leaf scale 1, complexity `medium`, and token advice unchanged at `100000/10000`.
- Evidence: `.repair/evidence/round2-dynamic-multiturn-pass.json`.
- Next action: run the real DeepSeek Minimal Flash and Pro Thinking smoke orchestrator against the pinned real Harness.

## 2026-08-22T15:03:41+10:00 — Real DeepSeek dual-mode smoke passed

- Real Minimal Flash: PASS in one immutable attempt with 9 Provider requests and 8 native `bash` calls. Every request used `thinking.type=disabled`; Provider wire evidence omitted `reasoning_effort` throughout. The exact leased file was reviewed, verified, fingerprint-stable, locally committed, and cleaned up.
- Real Pro Thinking: PASS in one immutable attempt with 4 Provider requests and 3 native `bash` calls. Every request used enabled/high and omitted `tool_choice`. Three real Provider reasoning payloads were persisted as SHA-256/UTF-8-length requirements and fully replayed on all later requests; replay counts were 3, 2, and 1, with no `INVALID_REQUEST`.
- Both leaves had exact `changedPaths`, approved per-file review, PASS verification, identical reviewed/current/verified fingerprints, isolated local commits, deleted worktrees/branches, and an unchanged clean smoke main.
- The credential file was copied without content inspection into an isolated mode-0600 `DSH_HOME` and the copy was removed after the run. No credential value appears in evidence.
- Evidence: `.repair/evidence/round2-real-provider-pass.json`; full redacted machine report: `/tmp/codex-real-rc2-evidence.json`.
- Next action: promote runtime/docs/release metadata to stable `0.6.5`, regenerate manifests, then run installation and package acceptance gates.

## 2026-08-22T15:14:13+10:00 — Stable promotion and pre-seal package gates passed

- Promoted all executable, installer, plugin and managed-marker version surfaces from internal rc.2 to stable `0.6.5`; rebuilt from strict TypeScript source.
- Stable regression: PASS, 74/74. Stable dynamic gate: Flash 4 requests, Pro 3 requests, missing-replay Provider 0 and tokens 0/0.
- Stable real Minimal Flash: PASS, one attempt, 7 Provider requests, 6 native calls, every request disabled with no wire reasoning effort, exact review/verification/fingerprint/commit/cleanup.
- Stable real Pro Thinking: PASS, one attempt, 7 Provider requests, 6 native calls, every request enabled/high with no tool choice; six real Provider reasoning requirements replayed 6/5/4/3/2/1 times, no `INVALID_REQUEST`, exact review/verification/fingerprint/commit/cleanup.
- Pre-seal package acceptance: PASS for fresh install, installed doctor and acceptance, config schema migration, same-version rollback, cross-version rollback with monitor restoration, reinstall, uninstall, and source hygiene.
- Packaged Codex skill updated for attempt policy and split-memory schema 4; official `skill-creator` quick validator returned `Skill is valid!`.
- Added stable release status, provenance, design/migration/operations reports, strict acceptance prompt, read-only audit prompt, and redacted stable evidence.
- Next action: regenerate the final manifest, rerun package acceptance on final content, commit stable/evidence state, build the ZIP, and revalidate the exact unpacked archive.

## 2026-08-22T15:17:36+10:00 — DELIVERABLE_PASS

- Final stable source commit: `e2581382415fc167f26d9ce49bb9a6a95a119a04`; nested source worktree is clean.
- Final source package acceptance: PASS after all stable metadata, reports and evidence entered the manifest.
- Final archive was created directly from the stable commit with `git archive`; no provisional or partial user package was emitted.
- ZIP: `deliverables/CODEX_HARNESS_BRIDGE_0_6_5_STABLE.zip`, 647739 bytes, 264 entries.
- SHA-256: `737ea4d5d148544cd1a2a605a1ec32f7de5ed2355f6c9b17b01bbf48344a7eba`.
- Fresh unpack validation: CRC PASS; no absolute/traversal path; no symlink; manifest 243/243 with exact ordinary-file coverage; stable release status PASS; skill validator PASS.
- Full `scripts/package-acceptance.sh` from the unpacked ZIP: PASS with exit code 0 for fresh install, installed acceptance, config upgrade, same-version rollback, cross-version rollback, stable reinstall, uninstall and package hygiene.
- Original outer main branch content was not merged with the repair branch; no push, tag or GitHub Release was performed.

## 2026-08-23T15:49:20+10:00 — Security audit repair R1 supersedes the prior stable artifact

- The 2026-08-22 archive and evidence remain in Git history but no longer serve as the current release gate because they predated the mandatory credential Broker, Bubblewrap isolation, strong process identity, operator API authentication and SHA-bound release governance.
- Restored the authoritative TypeScript source as ordinary outer tracked files; removed the URL-less gitlink and preserved the withdrawn failure history. Final pre-seal validation baseline: `80aa1f70276a32a8792f6a8c49d35b62f8be46af`, tree `b14f90f28c29e1264b64efd9240ac35b7a060cf3`.
- Repaired the reported `provider_protocol` anomaly with immutable attempt policies. Flash stays disabled and omits reasoning effort. Pro stays enabled/high with no tool choice; every non-empty Provider reasoning payload is hashed/length-checked and replayed exactly. Missing or altered replay aborts before later Provider I/O and never shrinks split memory.
- Final non-sandbox regression: PASS 83/83. Direct process acceptance, fixed real Harness + observable local Provider, replay failure injection, security acceptance and skill validation all PASS.
- Operator-authorized current real DeepSeek smoke: Minimal Flash PASS with 4 requests and 3 native tools; Pro Thinking PASS with 4 requests, 3 native tools and replay depths 0/1/2/3. No key, token, prompt or reasoning body is persisted in evidence.
- Candidate pre-seal package acceptance and final unpacked stable package acceptance both PASS for fresh install, installed tests/E2E/stdio, schema 4→7 migration, same-version rollback, cross-version rollback, reinstall, uninstall and package hygiene.
- Stable release gate binds six evidence files plus `SOURCE_PROVENANCE.json` and `bridge/package-lock.json`; all gates are exactly PASS.
- `scripts/build-deliverable.sh` produced two byte-identical deterministic ZIPs and revalidated the exact unpacked archive. Current ZIP: 763773 bytes, 309 entries, 308/308 manifest records.
- Current ZIP SHA-256: `d9285d89a7a2abfb268d687e3218dc2f20ea1401c2116f38c87d4fb9049752ca`; validation sidecar reports every check PASS.
- No merge, push, tag or GitHub Release was performed.

## 2026-08-23T16:03:15+10:00 — Final read-only audit correction and stable reseal

- A final read-only content audit found that `docs/11_REAL_PROVIDER_SMOKE_RUNBOOK_ZH.md` still described the superseded 7-request/6-call smoke shape. The runbook alone was corrected to the current redacted evidence: 4 Provider requests, 3 native calls, 3 reasoning requirements, replay counts 3/2/1 and depths 0/1/2/3.
- Regenerated the 308-entry source manifest, then reran the complete deterministic build and exact-unpacked validation. The previously generated `d9285d89a7a2abfb268d687e3218dc2f20ea1401c2116f38c87d4fb9049752ca` archive is superseded.
- Final archive: 763805 bytes, 309 ordinary ZIP entries, SHA-256 `0dc60c0d9ada0045cffec95a3ec7d74cfb9e292af197603943e8a2d9a2f7b640`. Deterministic double-build, CRC, unpacked manifest, stable release gate, complete 9-stage package acceptance, symlink hygiene and `node_modules` hygiene all PASS.
- No merge, push, tag or GitHub Release was performed.
