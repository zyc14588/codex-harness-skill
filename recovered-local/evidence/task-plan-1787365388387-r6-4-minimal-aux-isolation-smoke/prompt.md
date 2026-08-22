# CODEX-HARNESS BOUNDED LEAF CONTRACT

Task ID: plan-1787365388387-r6-4-minimal-aux-isolation-smoke
Controller plan: plan-1787365388387
Leaf: r6-4-minimal-aux-isolation-smoke
Mode: implementation
Complexity: trivial
Repository worktree: /home/zyc14588/aipt-worktrees/harness-AIPT-M0-B003/worktrees/AIPT-SA/plan-1787365388387-r6-4-minimal-aux-isolation-smoke
Base commit: 6d7225828b45b69ecc44d5bb51a04c40f0865aba

## Objective
Create exactly one repository-root file named R6_4_MINIMAL_AUX_ISOLATION_SMOKE.json. Use an available core mutation tool to write the file; do not merely describe the change. The file must be valid JSON and must express exactly this object with no additional keys: {"status":"PASS","executor":"harness","mode":"minimal","model":"deepseek-v4-flash","bridgeVersion":"0.6.4"}. Do not modify any other path. Do not stage or commit.

## Harness exclusive write leases
- R6_4_MINIMAL_AUX_ISOLATION_SMOKE.json

Only modify files covered by those leases. Reading other repository files is allowed only when needed for this bounded leaf. Do not modify Codex-owned paths, governance files, dependency locks, CI, or generated artifacts unless explicitly leased.

## Codex concurrent write leases (read-only to you)
- （无）

## Acceptance criteria
- R6_4_MINIMAL_AUX_ISOLATION_SMOKE.json exists at the repository root and is a regular text file.
- The file parses as valid JSON.
- The parsed JSON value equals exactly {"status":"PASS","executor":"harness","mode":"minimal","model":"deepseek-v4-flash","bridgeVersion":"0.6.4"} with no additional keys.
- The only changed path is R6_4_MINIMAL_AUX_ISOLATION_SMOKE.json.
- At least one actual core mutation tool is used for the formal implementation request.
- No staging, commit, merge, rebase, cherry-pick, push, tag, or publish operation is performed by the worker.

## Controller-selected context files to inspect first
- （无）

## Cumulative resource contract shared with all repairs
Execution gates (hard):
- Input tokens: 180000
- Output tokens: 240000
Reference thresholds only (never authorize or terminate execution):
- API calls: 20
- 配置价格估算参考值（人民币）: CN¥10

## Execution rules
1. Complete only this leaf. Do not expand the objective, redesign unrelated code, or recursively delegate.
2. Do not use web_search, web_fetch, curl, wget, or external research. Required research and context must come from Codex.
3. Inspect existing conventions before editing and prefer the smallest coherent change.
4. Stay inside the exclusive write leases. If an out-of-scope change is required, do not make it; report the blocker.
5. Run only focused checks needed for this leaf. Avoid broad exploratory test loops and repeated retries.
6. Do not stage, commit, merge, rebase, cherry-pick, push, tag, or modify another worktree. Leave the Git index and HEAD unchanged.
7. Do not ask the human to relay messages. Codex is the controller and will review every changed file.
8. Invoke model-visible tools directly. Never print DSML/XML markers or a Markdown shell code block as a substitute for a tool call. For a required mutation, use bash/pwsh/str_replace_editor, then verify the leased file exists before claiming completion.
9. Final response must contain RESULT, CHANGED_PATHS, TESTS, RISKS, and HANDOFF_TO_CODEX. Keep it factual and concise.
